import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import { createFileResourceIcon } from "../file-resource-icon";
import {
  fileTreeKeyboardAction,
  flattenFileTree,
  type VisibleFileRow,
} from "../file-explorer-tree";
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

  constructor(
    private readonly client: CcsmDesktopClient,
    private readonly openFile: (spaceId: string, relativePath: string) => void,
  ) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return new FileExplorerPanel(tab, this.client, this.openFile);
  }
}

class FileExplorerPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  readonly #openFile: (spaceId: string, relativePath: string) => void;
  readonly #entries = new Map<string, FileEntryDto[]>();
  #state: FileExplorerState;
  #tree: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #rows: VisibleFileRow[] = [];
  #disposed = false;
  #unlisten: (() => void) | null = null;
  readonly #pendingPaths = new Set<string>();
  readonly #scanner: BackgroundScanController;

  constructor(
    tab: TabDto,
    client: CcsmDesktopClient,
    openFile: (spaceId: string, relativePath: string) => void,
  ) {
    this.#tab = tab;
    this.#client = client;
    this.#openFile = openFile;
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
        <strong>Explorer</strong>
        <span class="files-status">Loading…</span>
        <button class="files-refresh" type="button" aria-label="Refresh Explorer" title="Refresh Explorer">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13 3v4H9"></path>
            <path d="M12.2 10.5A5 5 0 1 1 12 5"></path>
          </svg>
        </button>
      </div>
      <div class="files-tree" role="tree" aria-label="Files Explorer" tabindex="0"></div>
    `;
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    this.#tree = this.element.querySelector(".files-tree");
    this.#status = this.element.querySelector(".files-status");
    this.#tree?.addEventListener("keydown", (event) =>
      this.#handleTreeKeyDown(event),
    );
    this.element
      .querySelector(".files-refresh")
      ?.addEventListener("click", () => {
        this.#queueAllPaths();
        this.#setStatus("Refreshing…");
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
    this.#focusRow(this.#state.selectedPath);
  }
  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    this.#scanner.dispose();
  }

  async #loadDirectory(relativePath: string): Promise<void> {
    this.#setStatus("Loading…");
    try {
      const listing = await this.#client.backend.listDirectory({
        spaceId: this.#tab.spaceId,
        relativePath,
      });
      if (this.#disposed) return;
      this.#entries.set(relativePath, listing.entries);
      this.#setStatus("");
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
    this.#setStatus("");
  }

  #queueAllPaths(): void {
    this.#pendingPaths.add(this.#state.rootRelativePath);
    for (const path of this.#state.expandedPaths) this.#pendingPaths.add(path);
  }

  #render(requestedFocusPath: string | null = null): void {
    if (!this.#tree) return;
    const hadFocus = this.#tree.contains(document.activeElement);
    this.#rows = flattenFileTree(
      this.#state.rootRelativePath,
      this.#entries,
      this.#state.expandedPaths,
    );
    this.#tree.replaceChildren();
    this.#tree.tabIndex = this.#rows.length === 0 ? 0 : -1;
    for (const [index, item] of this.#rows.entries()) {
      const { entry, depth, expanded } = item;
      const row = document.createElement("div");
      row.className = "file-row";
      row.role = "treeitem";
      row.dataset.kind = entry.kind;
      row.dataset.path = entry.relativePath;
      row.dataset.selected = String(
        entry.relativePath === this.#state.selectedPath,
      );
      row.tabIndex =
        entry.relativePath === this.#state.selectedPath ||
        (!this.#state.selectedPath && index === 0)
          ? 0
          : -1;
      row.setAttribute(
        "aria-selected",
        String(entry.relativePath === this.#state.selectedPath),
      );
      row.setAttribute("aria-level", String(depth + 1));
      row.style.setProperty("--file-depth", String(depth));
      const isDirectory = entry.kind === "directory";
      if (isDirectory) row.setAttribute("aria-expanded", String(expanded));

      const guides = document.createElement("span");
      guides.className = "file-indent-guides";
      guides.setAttribute("aria-hidden", "true");
      for (let guideIndex = 0; guideIndex < depth; guideIndex += 1) {
        const guide = document.createElement("span");
        guide.className = "file-indent-guide";
        guides.append(guide);
      }

      const toggle = document.createElement(isDirectory ? "button" : "span");
      toggle.className = "file-toggle";
      toggle.setAttribute("aria-hidden", String(!isDirectory));
      if (toggle instanceof HTMLButtonElement) {
        toggle.type = "button";
        toggle.dataset.expanded = String(expanded);
        toggle.innerHTML = TREE_TWISTIE_ICON;
        toggle.setAttribute(
          "aria-label",
          `${expanded ? "Collapse" : "Expand"} ${entry.name}`,
        );
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          this.#selectPath(entry.relativePath, true);
          void this.#toggleDirectory(entry.relativePath, expanded);
        });
      }

      const icon = createFileResourceIcon(entry.name, entry.kind, expanded);

      const label = document.createElement("span");
      label.className = "file-name";
      label.textContent = entry.name;
      label.title = entry.relativePath;
      row.addEventListener("focus", () => this.#setRovingFocus(row));
      row.addEventListener("click", (event) => {
        this.#selectPath(entry.relativePath, true);
        if (entry.kind === "file") {
          this.#openFile(this.#tab.spaceId, entry.relativePath);
        } else if (isDirectory && event.detail === 1) {
          void this.#toggleDirectory(entry.relativePath, expanded);
        }
      });
      row.append(guides, toggle, icon, label);
      this.#tree.append(row);
    }
    if (hadFocus || requestedFocusPath)
      this.#focusRow(requestedFocusPath ?? this.#state.selectedPath);
  }

  async #toggleDirectory(path: string, expanded: boolean): Promise<void> {
    this.#state.expandedPaths = expanded
      ? this.#state.expandedPaths.filter((value) => value !== path)
      : [...this.#state.expandedPaths, path];
    if (!expanded && !this.#entries.has(path)) await this.#loadDirectory(path);
    this.#render(path);
    await this.#persist();
  }

  #handleTreeKeyDown(event: KeyboardEvent): void {
    if (!isFileTreeKey(event.key)) return;
    const targetPath = (event.target as Element | null)?.closest<HTMLElement>(
      ".file-row",
    )?.dataset.path;
    const result = fileTreeKeyboardAction(
      this.#rows,
      targetPath ?? this.#state.selectedPath,
      event.key,
    );
    if (!result) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.action === "focus") {
      this.#selectPath(result.path, true);
      return;
    }
    const row = this.#rows.find(
      (candidate) => candidate.entry.relativePath === result.path,
    );
    if (!row) return;
    if (result.action === "open") {
      this.#selectPath(result.path, true);
      this.#openFile(this.#tab.spaceId, result.path);
      return;
    }
    this.#selectPath(result.path, true);
    void this.#toggleDirectory(result.path, result.action === "collapse");
  }

  #selectPath(path: string, focus: boolean): void {
    this.#state.selectedPath = path;
    if (this.#tree) {
      for (const row of this.#tree.querySelectorAll<HTMLElement>(".file-row")) {
        const selected = row.dataset.path === path;
        row.dataset.selected = String(selected);
        row.setAttribute("aria-selected", String(selected));
        row.tabIndex = selected ? 0 : -1;
        if (selected && focus) row.focus({ preventScroll: true });
      }
    }
    void this.#persist().catch((error) =>
      this.#setStatus(`Error · ${describeError(error)}`),
    );
  }

  #setRovingFocus(active: HTMLElement): void {
    if (!this.#tree) return;
    for (const row of this.#tree.querySelectorAll<HTMLElement>(".file-row"))
      row.tabIndex = row === active ? 0 : -1;
  }

  #focusRow(path: string | null): void {
    const row = [
      ...(this.#tree?.querySelectorAll<HTMLElement>(".file-row") ?? []),
    ].find((candidate) => candidate.dataset.path === path);
    (row ?? this.#tree)?.focus({ preventScroll: true });
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

function isFileTreeKey(
  key: string,
): key is Parameters<typeof fileTreeKeyboardAction>[2] {
  return [
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "End",
    "Enter",
    "Home",
  ].includes(key);
}

const TREE_TWISTIE_ICON = `
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m5.5 3.5 4.5 4.5-4.5 4.5"></path>
  </svg>`;
