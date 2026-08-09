import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import type { FileEntryDto } from "../generated/FileEntryDto";
import type { TabDto } from "../generated/TabDto";
import { affectedLoadedDirectories } from "../scan-routing";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

interface FileExplorerState {
  rootRelativePath: string;
  expandedPaths: string[];
  selectedPath: string | null;
}

export class FileExplorerTabProvider implements TabProvider {
  readonly kind = "file-explorer" as const;

  constructor(private readonly client: CcsmDesktopClient) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return new FileExplorerPanel(tab, this.client);
  }
}

class FileExplorerPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  readonly #entries = new Map<string, FileEntryDto[]>();
  #state: FileExplorerState;
  #tree: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #disposed = false;
  #unlisten: (() => void) | null = null;
  readonly #pendingPaths = new Set<string>();
  readonly #scanner: BackgroundScanController;

  constructor(tab: TabDto, client: CcsmDesktopClient) {
    this.#tab = tab;
    this.#client = client;
    this.#state = parseState(tab.state);
    this.#scanner = new BackgroundScanController(
      (manual) => this.#runRefresh(manual),
      (error) => {
        if (!this.#disposed)
          this.#setStatus(`paused · ${describeError(error)}`);
      },
      {
        maxBurstRuns: 2,
        cooldownMs: 1_500,
        failureThreshold: 2,
        failureCooldownMs: 8_000,
        timeoutMs: 5_000,
      },
    );
    this.element.className = "file-explorer-panel";
    this.element.innerHTML = `
      <div class="files-toolbar">
        <strong>Files</strong>
        <span class="files-status">loading</span>
        <button class="files-refresh" type="button">Refresh</button>
      </div>
      <div class="files-tree" role="tree" aria-label="File Explorer"></div>
    `;
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    this.#tree = this.element.querySelector(".files-tree");
    this.#status = this.element.querySelector(".files-status");
    this.element
      .querySelector(".files-refresh")
      ?.addEventListener("click", () => {
        this.#queueAllPaths();
        this.#setStatus("refreshing");
        this.#scanner.request(true);
      });
    void this.#client.events
      .subscribe((event) => {
        if (event.kind !== "filesystem.changed") return;
        const affected = affectedLoadedDirectories(event.payload, [
          this.#state.rootRelativePath,
          ...this.#entries.keys(),
        ]);
        for (const path of affected) this.#pendingPaths.add(path);
        if (affected.length > 0) this.#scanner.request();
      })
      .then((unlisten) => {
        if (this.#disposed) unlisten();
        else this.#unlisten = unlisten;
      });
    this.#pendingPaths.add(this.#state.rootRelativePath);
    this.#scanner.request(true);
  }

  layout(): void {}
  focus(): void {
    this.#tree?.focus();
  }
  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    this.#scanner.dispose();
  }

  async #loadDirectory(relativePath: string): Promise<void> {
    this.#setStatus("loading");
    try {
      const listing = await this.#client.backend.listDirectory({
        spaceId: this.#tab.spaceId,
        relativePath,
      });
      if (this.#disposed) return;
      this.#entries.set(relativePath, listing.entries);
      this.#render();
      this.#setStatus(`${this.#entries.size} folders loaded`);
    } catch (error) {
      this.#setStatus(`error · ${describeError(error)}`);
    }
  }

  async #runRefresh(manual: boolean): Promise<void> {
    if (manual) this.#queueAllPaths();
    const paths = [...this.#pendingPaths];
    for (const path of paths) this.#pendingPaths.delete(path);
    if (paths.length === 0) return;
    let firstError: unknown;
    for (const relativePath of paths) {
      try {
        const listing = await this.#client.backend.listDirectory({
          spaceId: this.#tab.spaceId,
          relativePath,
        });
        if (this.#disposed) return;
        this.#entries.set(relativePath, listing.entries);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.#disposed) return;
    this.#render();
    if (firstError) throw firstError;
    this.#setStatus(`${this.#entries.size} folders loaded`);
  }

  #queueAllPaths(): void {
    this.#pendingPaths.add(this.#state.rootRelativePath);
    for (const path of this.#state.expandedPaths) this.#pendingPaths.add(path);
  }

  #render(): void {
    if (!this.#tree) return;
    this.#tree.replaceChildren();
    this.#renderChildren(this.#state.rootRelativePath, 0, this.#tree);
  }

  #renderChildren(
    relativePath: string,
    depth: number,
    parent: HTMLElement,
  ): void {
    const entries = this.#entries.get(relativePath) ?? [];
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.role = "treeitem";
      row.dataset.kind = entry.kind;
      row.dataset.selected = String(
        entry.relativePath === this.#state.selectedPath,
      );
      row.style.setProperty("--file-depth", String(depth));
      const isDirectory = entry.kind === "directory";
      const expanded =
        isDirectory && this.#state.expandedPaths.includes(entry.relativePath);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "file-toggle";
      toggle.disabled = !isDirectory;
      toggle.textContent = isDirectory
        ? expanded
          ? "▾"
          : "▸"
        : fileGlyph(entry);
      toggle.setAttribute(
        "aria-label",
        isDirectory
          ? `${expanded ? "Collapse" : "Expand"} ${entry.name}`
          : entry.name,
      );
      toggle.addEventListener("click", () => {
        if (isDirectory)
          void this.#toggleDirectory(entry.relativePath, expanded);
      });
      const label = document.createElement("button");
      label.type = "button";
      label.className = "file-name";
      label.textContent = entry.name;
      label.title = entry.relativePath;
      label.addEventListener("click", () => {
        this.#state.selectedPath = entry.relativePath;
        this.#render();
        void this.#persist();
      });
      const meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent =
        entry.kind === "file" && entry.size !== null
          ? formatBytes(entry.size)
          : "";
      row.append(toggle, label, meta);
      parent.append(row);
      if (expanded) {
        const children = document.createElement("div");
        children.className = "file-children";
        this.#renderChildren(entry.relativePath, depth + 1, children);
        parent.append(children);
      }
    }
  }

  async #toggleDirectory(path: string, expanded: boolean): Promise<void> {
    this.#state.expandedPaths = expanded
      ? this.#state.expandedPaths.filter((value) => value !== path)
      : [...this.#state.expandedPaths, path];
    if (!expanded && !this.#entries.has(path)) await this.#loadDirectory(path);
    this.#render();
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await this.#client.backend.updateTabState({
      tabId: this.#tab.id,
      title: this.#tab.title,
      stateVersion: 1,
      state: this.#state,
    });
  }

  #setStatus(value: string): void {
    if (this.#status && this.#status.textContent !== value)
      this.#status.textContent = value;
  }
}

function parseState(value: unknown): FileExplorerState {
  if (value && typeof value === "object") {
    const state = value as Partial<FileExplorerState>;
    return {
      rootRelativePath:
        typeof state.rootRelativePath === "string"
          ? state.rootRelativePath
          : "",
      expandedPaths: Array.isArray(state.expandedPaths)
        ? state.expandedPaths.filter(
            (path): path is string => typeof path === "string",
          )
        : [],
      selectedPath:
        typeof state.selectedPath === "string" ? state.selectedPath : null,
    };
  }
  return { rootRelativePath: "", expandedPaths: [], selectedPath: null };
}

function fileGlyph(entry: FileEntryDto): string {
  if (entry.kind === "symlink") return "↗";
  if (entry.kind === "file") return "·";
  return "◇";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
