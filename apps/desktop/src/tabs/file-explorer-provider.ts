import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import { createFileResourceIcon } from "../file-resource-icon";
import { FrameTaskScheduler } from "../frame-task-scheduler";
import {
  fileTreeKeyboardAction,
  flattenFileTreeItems,
  type VisibleFileRow,
  type VisibleFileTreeItem,
} from "../file-explorer-tree";
import type { FileEntryDto } from "../generated/FileEntryDto";
import type { TabDto } from "../generated/TabDto";
import { affectedLoadedDirectories } from "../scan-routing";
import { listWindow } from "../list-window";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

interface FileExplorerState {
  rootRelativePath: string;
  expandedPaths: string[];
  selectedPath: string | null;
}

const EXPLORER_PAGE_SIZE = 200;
const EXPLORER_ROW_HEIGHT = 22;

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
  readonly #nextOffsets = new Map<string, number>();
  #state: FileExplorerState;
  #tree: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #rows: VisibleFileRow[] = [];
  #items: VisibleFileTreeItem[] = [];
  readonly #topSpacer = document.createElement("div");
  readonly #rowWindow = document.createElement("div");
  readonly #bottomSpacer = document.createElement("div");
  #windowStart = -1;
  #windowEnd = -1;
  readonly #windowScheduler = new FrameTaskScheduler(1);
  #disposed = false;
  #unlisten: (() => void) | null = null;
  readonly #pendingPaths = new Set<string>();
  readonly #activeOperationIds = new Set<string>();
  readonly #loadingMorePaths = new Set<string>();
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
    (this.element as FileExplorerDebugElement).__CCSM_EXPLORER_DEBUG__ =
      () => ({
        totalItems: this.#items.length,
        renderedItems: Math.max(0, this.#windowEnd - this.#windowStart),
        hasPath: (path: string) =>
          this.#items.some(
            (item) =>
              item.itemKind === "entry" && item.entry.relativePath === path,
          ),
        reveal: (path: string) => this.#debugReveal(path),
      });
    this.#scanner = new BackgroundScanController(
      (manual, signal) => this.#runRefresh(manual, signal),
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
    this.#tree?.addEventListener("scroll", this.#scheduleWindowRender, {
      passive: true,
    });
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
    this.#windowScheduler.clear();
    for (const operationId of this.#activeOperationIds) {
      void this.#client.backend.cancelDirectoryOperation(operationId);
    }
    this.#activeOperationIds.clear();
    delete (this.element as FileExplorerDebugElement).__CCSM_EXPLORER_DEBUG__;
  }

  async #loadDirectory(relativePath: string): Promise<void> {
    this.#setStatus("Loading…");
    try {
      const listing = await this.#listDirectoryPage(relativePath, 0);
      if (this.#disposed) return;
      this.#entries.set(relativePath, listing.entries);
      this.#setNextOffset(relativePath, listing.nextOffset);
      this.#setStatus("");
    } catch (error) {
      this.#setStatus(`error · ${describeError(error)}`);
    }
  }

  async #runRefresh(manual: boolean, signal: AbortSignal): Promise<void> {
    if (manual) this.#queueAllPaths();
    const paths = [...this.#pendingPaths];
    for (const path of paths) this.#pendingPaths.delete(path);
    if (paths.length === 0) return;
    let firstError: unknown;
    for (const relativePath of paths) {
      if (signal.aborted) {
        firstError ??= abortError(signal);
        break;
      }
      try {
        const listing = await this.#listDirectoryPage(relativePath, 0, signal);
        if (this.#disposed) return;
        this.#entries.set(relativePath, listing.entries);
        this.#setNextOffset(relativePath, listing.nextOffset);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.#disposed) return;
    this.#render();
    if (firstError) throw firstError;
    this.#setStatus("");
  }

  async #listDirectoryPage(
    relativePath: string,
    offset: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw abortError(signal);
    const operationId = crypto.randomUUID();
    this.#activeOperationIds.add(operationId);
    const cancel = () => {
      void this.#client.backend.cancelDirectoryOperation(operationId);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.#client.backend.listDirectory({
        spaceId: this.#tab.spaceId,
        relativePath,
        operationId,
        offset,
        limit: EXPLORER_PAGE_SIZE,
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.#activeOperationIds.delete(operationId);
    }
  }

  #setNextOffset(relativePath: string, nextOffset: number | null): void {
    if (nextOffset === null) this.#nextOffsets.delete(relativePath);
    else this.#nextOffsets.set(relativePath, nextOffset);
  }

  async #loadNextPage(relativePath: string, offset: number): Promise<void> {
    if (this.#loadingMorePaths.has(relativePath)) return;
    this.#loadingMorePaths.add(relativePath);
    this.#setStatus("Loading more…");
    this.#render();
    try {
      const listing = await this.#listDirectoryPage(relativePath, offset);
      if (this.#disposed) return;
      this.#entries.set(relativePath, [
        ...(this.#entries.get(relativePath) ?? []),
        ...listing.entries,
      ]);
      this.#setNextOffset(relativePath, listing.nextOffset);
      this.#setStatus("");
    } catch (error) {
      if (!this.#disposed) this.#setStatus(`error · ${describeError(error)}`);
    } finally {
      this.#loadingMorePaths.delete(relativePath);
      if (!this.#disposed) this.#render();
    }
  }

  #queueAllPaths(): void {
    this.#pendingPaths.add(this.#state.rootRelativePath);
    for (const path of this.#state.expandedPaths) this.#pendingPaths.add(path);
  }

  #render(requestedFocusPath: string | null = null): void {
    const tree = this.#tree;
    if (!tree) return;
    const hadFocus = tree.contains(document.activeElement);
    const previousScrollTop = tree.scrollTop;
    this.#items = flattenFileTreeItems(
      this.#state.rootRelativePath,
      this.#entries,
      this.#state.expandedPaths,
      this.#nextOffsets,
    );
    this.#rows = this.#items.flatMap((item) =>
      item.itemKind === "entry" ? [item] : [],
    );
    this.#topSpacer.className = "files-tree-spacer";
    this.#rowWindow.className = "files-tree-window";
    this.#bottomSpacer.className = "files-tree-spacer";
    tree.replaceChildren(this.#topSpacer, this.#rowWindow, this.#bottomSpacer);
    tree.tabIndex = this.#rows.length === 0 ? 0 : -1;
    tree.dataset.totalItems = String(this.#items.length);
    this.#windowStart = -1;
    this.#windowEnd = -1;
    this.#renderWindow();
    if (requestedFocusPath) this.#scrollPathIntoView(requestedFocusPath);
    else if (previousScrollTop > 0) {
      tree.scrollTop = previousScrollTop;
      this.#windowStart = -1;
      this.#windowEnd = -1;
      this.#renderWindow();
    }
    if (hadFocus || requestedFocusPath)
      this.#focusRow(requestedFocusPath ?? this.#state.selectedPath);
  }

  readonly #scheduleWindowRender = (): void => {
    this.#windowScheduler.enqueue(
      "explorer-window",
      () => this.#renderWindow(),
      true,
    );
  };

  #renderWindow(): void {
    const tree = this.#tree;
    if (!tree) return;
    const window = listWindow(
      this.#items.length,
      tree.scrollTop,
      tree.clientHeight || 660,
      EXPLORER_ROW_HEIGHT,
    );
    if (window.start === this.#windowStart && window.end === this.#windowEnd)
      return;
    this.#windowStart = window.start;
    this.#windowEnd = window.end;
    const fragment = document.createDocumentFragment();
    for (let index = window.start; index < window.end; index += 1) {
      const item = this.#items[index];
      if (item) fragment.append(this.#createTreeItem(item, index));
    }
    this.#topSpacer.style.height = `${window.paddingBefore}px`;
    this.#rowWindow.replaceChildren(fragment);
    this.#bottomSpacer.style.height = `${window.paddingAfter}px`;
    tree.dataset.renderedItems = String(window.end - window.start);
  }

  #createTreeItem(item: VisibleFileTreeItem, index: number): HTMLElement {
    if (item.itemKind === "more") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-load-more";
      button.dataset.parentPath = item.parentPath;
      button.style.setProperty("--file-depth", String(item.depth));
      button.textContent = `Load ${EXPLORER_PAGE_SIZE} more…`;
      button.disabled = this.#loadingMorePaths.has(item.parentPath);
      button.addEventListener(
        "click",
        () => void this.#loadNextPage(item.parentPath, item.nextOffset),
      );
      return button;
    }
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
    return row;
  }

  #scrollPathIntoView(path: string): void {
    const tree = this.#tree;
    if (!tree) return;
    const index = this.#items.findIndex(
      (item) => item.itemKind === "entry" && item.entry.relativePath === path,
    );
    if (index < 0) return;
    const top = index * EXPLORER_ROW_HEIGHT;
    const bottom = top + EXPLORER_ROW_HEIGHT;
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (bottom > tree.scrollTop + tree.clientHeight)
      tree.scrollTop = Math.max(0, bottom - tree.clientHeight);
    this.#renderWindow();
  }

  #debugReveal(path: string): boolean {
    const index = this.#items.findIndex(
      (item) => item.itemKind === "entry" && item.entry.relativePath === path,
    );
    const tree = this.#tree;
    if (index < 0 || !tree) return false;
    tree.scrollTop = index * EXPLORER_ROW_HEIGHT;
    this.#windowStart = -1;
    this.#windowEnd = -1;
    this.#renderWindow();
    return true;
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
    if (focus) this.#scrollPathIntoView(path);
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
    if (path) this.#scrollPathIntoView(path);
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("directory scan aborted", "AbortError");
}

const TREE_TWISTIE_ICON = `
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m5.5 3.5 4.5 4.5-4.5 4.5"></path>
  </svg>`;

type FileExplorerDebugElement = HTMLElement & {
  __CCSM_EXPLORER_DEBUG__?: () => {
    totalItems: number;
    renderedItems: number;
    hasPath(path: string): boolean;
    reveal(path: string): boolean;
  };
};
