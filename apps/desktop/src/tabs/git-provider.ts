import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import { createFileResourceIcon } from "../file-resource-icon";
import { FrameTaskScheduler } from "../frame-task-scheduler";
import {
  flattenGitDiff,
  gitChangeBadge,
  gitChangeKey,
  gitChangeMatchesFilter,
  gitDiffContentColumns,
  gitFileName,
  gitParentPath,
  type GitDisplayLine,
} from "../git-diff-model";
import type { GitFileChangeDto } from "../generated/GitFileChangeDto";
import type { GitFileDiffDto } from "../generated/GitFileDiffDto";
import type { GitRepositoryStatusDto } from "../generated/GitRepositoryStatusDto";
import type { GitSnapshotDto } from "../generated/GitSnapshotDto";
import type { TabDto } from "../generated/TabDto";
import { GitScanVisibility } from "../git-scan-visibility";
import { GIT_DIFF_ROW_HEIGHT, gitDiffVirtualWindow } from "../git-diff-window";
import { observePanelVisibility } from "../panel-visibility";
import { gitChangeNeedsScan } from "../scan-routing";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

interface GitTabState {
  collapsedRepositoryIds: string[];
  collapsedDiffKeys: string[];
  selectedDiffKey: string | null;
}

interface GitDiffEntry {
  repository: GitRepositoryStatusDto;
  change: GitFileChangeDto;
  view: GitDiffFileView;
  loadState: "idle" | "queued" | "loading" | "loaded" | "error";
}

interface GitDiffLoadQueue {
  generation: number;
  pending: string[];
  queued: Set<string>;
  active: number;
}

interface SyntaxToken {
  from: number;
  to: number;
  classes: string;
}

const DIFF_GUTTER_COLUMNS = 22;
const DIFF_LOAD_CONCURRENCY = 2;
const DIFF_LOAD_ROOT_MARGIN = 800;

export class GitTabProvider implements TabProvider {
  readonly kind = "git" as const;

  constructor(private readonly client: CcsmDesktopClient) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return new GitPanel(tab, this.client);
  }
}

class GitPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  readonly #scanner: BackgroundScanController;
  readonly #entries = new Map<string, GitDiffEntry>();
  readonly #repositoryGroups = new Map<string, HTMLElement>();
  readonly #navigationButtons = new Map<string, HTMLButtonElement>();
  readonly #diffKeysByElement = new WeakMap<HTMLElement, string>();
  #state: GitTabState;
  #snapshot: GitSnapshotDto | null = null;
  #status: HTMLElement | null = null;
  #summaryCount: HTMLElement | null = null;
  #diffPane: HTMLElement | null = null;
  #diffList: HTMLElement | null = null;
  #navigationList: HTMLElement | null = null;
  #filterInput: HTMLInputElement | null = null;
  #filter = "";
  #disposed = false;
  #unlisten: (() => void) | null = null;
  #visibilitySubscription: { dispose(): void } | null = null;
  readonly #scanVisibility = new GitScanVisibility();
  #loadGeneration = 0;
  #loadQueue: GitDiffLoadQueue = {
    generation: 0,
    pending: [],
    queued: new Set(),
    active: 0,
  };
  #intersectionObserver: IntersectionObserver | null = null;
  readonly #nearViewportKeys = new Set<string>();
  readonly #layoutScheduler = new FrameTaskScheduler(2);
  #persistTimer: number | null = null;
  #diffContentColumns = DIFF_GUTTER_COLUMNS;
  #refreshRevision = 0;

  constructor(tab: TabDto, client: CcsmDesktopClient) {
    this.#tab = tab;
    this.#client = client;
    this.#state = parseState(tab.state);
    (this.element as GitDebugElement).__CCSM_GIT_DEBUG__ = () => ({
      files: [...this.#entries.values()].map((entry) => ({
        path: entry.change.path,
        loadState: entry.loadState,
        totalRows: Number(entry.view.element.dataset.totalRows ?? 0),
        renderedRows: Number(entry.view.element.dataset.renderedRows ?? 0),
        message: entry.view.message,
      })),
    });
    this.#scanner = new BackgroundScanController(
      (manual, signal) => this.#runScan(manual, signal),
      (error) => {
        if (!this.#disposed)
          this.#setStatus(`paused · ${describeError(error)}`);
      },
      {
        maxBurstRuns: 1,
        cooldownMs: 3_000,
        failureThreshold: 2,
        failureCooldownMs: 15_000,
        timeoutMs: 12_000,
      },
    );
    this.element.className = "git-panel";
    this.element.dataset.refreshRevision = "0";
    this.element.dataset.scanState = "idle";
    this.element.innerHTML = `
      <div class="git-toolbar">
        <strong>Changes</strong>
        <span class="git-status">loading cache</span>
        <button class="git-refresh" type="button" aria-label="Refresh changes" title="Refresh changes">↻</button>
      </div>
      <div class="git-summary">
        <strong>Uncommitted</strong>
        <span class="git-summary-count">0</span>
      </div>
      <div class="git-changes-layout">
        <div class="git-diff-pane" tabindex="0" aria-label="File changes">
          <div class="git-diff-list"></div>
        </div>
        <aside class="git-navigation" aria-label="Changed files">
          <label class="git-filter">
            <input type="search" aria-label="Filter changed files" placeholder="Filter files…" autocomplete="off" spellcheck="false" />
          </label>
          <div class="git-navigation-list"></div>
        </aside>
      </div>
    `;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.#status = required<HTMLElement>(this.element, ".git-status");
    this.#summaryCount = required<HTMLElement>(
      this.element,
      ".git-summary-count",
    );
    const diffPane = required<HTMLElement>(this.element, ".git-diff-pane");
    this.#diffPane = diffPane;
    this.#diffList = required<HTMLElement>(this.element, ".git-diff-list");
    this.#navigationList = required<HTMLElement>(
      this.element,
      ".git-navigation-list",
    );
    const filterInput = required<HTMLInputElement>(
      this.element,
      ".git-filter input",
    );
    this.#filterInput = filterInput;
    this.#visibilitySubscription = observePanelVisibility(
      parameters.api,
      (isVisible) => {
        if (this.#scanVisibility.setVisible(isVisible)) {
          this.#scanner.request();
        }
      },
    );
    this.element
      .querySelector(".git-refresh")
      ?.addEventListener("click", () => {
        this.#scanVisibility.markDirty();
        this.#scanner.request(true);
      });
    filterInput.addEventListener("input", () => {
      this.#filter = filterInput.value;
      this.#applyFilter();
    });
    diffPane.addEventListener("scroll", this.#onDiffScroll, {
      passive: true,
    });
    this.#intersectionObserver = new IntersectionObserver(
      this.#onDiffIntersection,
      {
        root: diffPane,
        rootMargin: `${DIFF_LOAD_ROOT_MARGIN}px 0px`,
      },
    );
    void this.#client.events
      .subscribe((event) => {
        if (
          event.kind === "filesystem.changed" &&
          gitChangeNeedsScan(event.payload, this.#snapshot)
        ) {
          if (this.#scanVisibility.markDirty()) this.#scanner.request();
        }
      })
      .then((unlisten) => {
        if (this.#disposed) unlisten();
        else this.#unlisten = unlisten;
      });
    void this.#initialize();
  }

  layout(): void {}

  focus(): void {
    this.#diffPane?.focus();
  }

  dispose(): void {
    this.#disposed = true;
    this.#loadGeneration += 1;
    this.#unlisten?.();
    this.#visibilitySubscription?.dispose();
    this.#unlisten = null;
    this.#scanner.dispose();
    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = null;
    this.#nearViewportKeys.clear();
    this.#layoutScheduler.clear();
    if (this.#persistTimer !== null) {
      window.clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
      this.#persistStateNow();
    }
    for (const entry of this.#entries.values()) entry.view.destroy();
    this.#entries.clear();
    delete (this.element as GitDebugElement).__CCSM_GIT_DEBUG__;
  }

  async #initialize(): Promise<void> {
    try {
      this.#snapshot = await this.#client.backend.cachedGit(this.#tab.spaceId);
      this.#render();
    } catch {
      // The refresh below reconciles an empty or stale cache.
    }
    if (this.#scanVisibility.setReady()) this.#scanner.request();
  }

  async #runScan(manual: boolean, _signal: AbortSignal): Promise<void> {
    const revision = this.#scanVisibility.beginScan();
    await this.#refresh(manual);
    if (!this.#disposed && this.#scanVisibility.completeScan(revision)) {
      this.#scanner.request();
    }
  }

  async #refresh(manual: boolean): Promise<void> {
    if (manual) this.#setStatus("scanning");
    this.element.dataset.scanState = "scanning";
    try {
      const snapshot = await this.#client.backend.refreshGit({
        spaceId: this.#tab.spaceId,
      });
      if (this.#disposed) return;
      this.#snapshot = snapshot;
      this.#render();
      this.#refreshRevision += 1;
      this.element.dataset.refreshRevision = String(this.#refreshRevision);
      const changes = changeCount(snapshot);
      this.#setStatus(
        `${snapshot.repositories.length} repos · ${changes} changes`,
      );
    } finally {
      this.element.dataset.scanState = "idle";
    }
  }

  #render(): void {
    const diffList = this.#diffList;
    const diffPane = this.#diffPane;
    if (!diffList || !diffPane) return;
    const previousScrollTop = diffPane.scrollTop;
    const generation = ++this.#loadGeneration;
    this.#loadQueue = {
      generation,
      pending: [],
      queued: new Set(),
      active: 0,
    };
    this.#intersectionObserver?.disconnect();
    this.#nearViewportKeys.clear();
    for (const entry of this.#entries.values()) entry.view.destroy();
    this.#entries.clear();
    this.#repositoryGroups.clear();
    this.#navigationButtons.clear();
    diffList.replaceChildren();
    this.#diffContentColumns = DIFF_GUTTER_COLUMNS;
    diffList.style.setProperty(
      "--git-diff-content-columns",
      String(this.#diffContentColumns),
    );
    diffList.classList.add("is-virtualized");

    const repositories = this.#snapshot?.repositories ?? [];
    const totalChanges = repositories.reduce(
      (total, repository) => total + repository.files.length,
      0,
    );
    if (this.#summaryCount)
      this.#summaryCount.textContent = String(totalChanges);
    diffList.dataset.totalFiles = String(totalChanges);

    if (repositories.length === 0) {
      diffList.append(
        statusElement(
          "git-empty",
          "No repositories found at the Space root or its direct children.",
        ),
      );
      this.#renderNavigation();
      return;
    }

    const changedRepositories = repositories.filter(
      (repository) => repository.files.length > 0,
    );
    diffList.classList.toggle(
      "has-multiple-repositories",
      changedRepositories.length > 1,
    );
    if (totalChanges === 0) {
      diffList.append(statusElement("git-clean", "Working tree clean"));
    } else {
      for (const repository of repositories) {
        if (repository.error) {
          diffList.append(
            statusElement(
              "git-error git-diff-repository-error",
              `${repositoryLabel(repository)} · ${repository.error}`,
            ),
          );
          continue;
        }
        if (repository.files.length === 0) continue;
        const group = document.createElement("section");
        group.className = "git-diff-repository";
        this.#repositoryGroups.set(repository.repositoryId, group);
        if (changedRepositories.length > 1) {
          const heading = document.createElement("div");
          heading.className = "git-diff-repository-heading";
          const name = document.createElement("strong");
          name.textContent = repositoryLabel(repository);
          const branch = document.createElement("span");
          branch.textContent = repository.branch ?? "detached";
          heading.append(name, branch);
          group.append(heading);
        }
        for (const change of repository.files) {
          const key = gitChangeKey(repository.repositoryId, change.path);
          const view = new GitDiffFileView(
            repository,
            change,
            this.#state.collapsedDiffKeys.includes(key),
            (collapsed) => this.#setDiffCollapsed(key, collapsed),
          );
          this.#entries.set(key, {
            repository,
            change,
            view,
            loadState: "idle",
          });
          this.#diffKeysByElement.set(view.element, key);
          group.append(view.element);
        }
        diffList.append(group);
      }
    }

    if (
      !this.#state.selectedDiffKey ||
      !this.#entries.has(this.#state.selectedDiffKey)
    ) {
      this.#state.selectedDiffKey = this.#entries.keys().next().value ?? null;
    }
    this.#applyFilter();
    for (const entry of this.#entries.values()) {
      this.#intersectionObserver?.observe(entry.view.element);
    }
    this.#layoutScheduler.enqueue(
      "git-initial-layout",
      () => {
        if (generation !== this.#loadGeneration || this.#disposed) return;
        if (this.#diffPane) this.#diffPane.scrollTop = previousScrollTop;
        this.#updateDiffViewports();
        this.#syncSelectionFromScroll();
        if (this.#nearViewportKeys.size === 0 && this.#state.selectedDiffKey) {
          this.#requestDiff(this.#state.selectedDiffKey, true);
        }
      },
      true,
    );
  }

  #requestDiff(key: string, priority = false): void {
    const entry = this.#entries.get(key);
    const queue = this.#loadQueue;
    if (!entry || entry.loadState !== "idle" || queue.queued.has(key)) return;
    entry.loadState = "queued";
    queue.queued.add(key);
    if (priority) queue.pending.unshift(key);
    else queue.pending.push(key);
    this.#pumpDiffLoads(queue);
  }

  #pumpDiffLoads(queue: GitDiffLoadQueue): void {
    while (
      queue === this.#loadQueue &&
      queue.active < DIFF_LOAD_CONCURRENCY &&
      queue.pending.length > 0
    ) {
      const key = queue.pending.shift();
      if (!key) continue;
      queue.queued.delete(key);
      const entry = this.#entries.get(key);
      if (!entry || entry.loadState !== "queued") continue;
      entry.loadState = "loading";
      queue.active += 1;
      void this.#loadDiff(queue, key, entry);
    }
  }

  async #loadDiff(
    queue: GitDiffLoadQueue,
    key: string,
    entry: GitDiffEntry,
  ): Promise<void> {
    try {
      const diff = await this.#client.backend.readGitDiff({
        spaceId: this.#tab.spaceId,
        repositoryId: entry.repository.repositoryId,
        path: entry.change.path,
      });
      if (
        this.#disposed ||
        queue !== this.#loadQueue ||
        queue.generation !== this.#loadGeneration ||
        this.#entries.get(key) !== entry
      ) {
        return;
      }
      entry.loadState = "loaded";
      this.#setDiffContentColumns(entry.view.render(diff));
      entry.view.updateViewport(
        this.#diffPane?.getBoundingClientRect() ?? null,
      );
    } catch (error) {
      if (
        this.#disposed ||
        queue !== this.#loadQueue ||
        queue.generation !== this.#loadGeneration ||
        this.#entries.get(key) !== entry
      ) {
        return;
      }
      entry.loadState = "error";
      entry.view.renderError(describeError(error));
    } finally {
      queue.active = Math.max(0, queue.active - 1);
      if (queue === this.#loadQueue) this.#pumpDiffLoads(queue);
    }
  }

  #applyFilter(): void {
    for (const entry of this.#entries.values()) {
      entry.view.element.hidden = !gitChangeMatchesFilter(
        entry.repository,
        entry.change,
        this.#filter,
      );
    }
    for (const [repositoryId, group] of this.#repositoryGroups) {
      group.hidden = ![...this.#entries.values()].some(
        (entry) =>
          entry.repository.repositoryId === repositoryId &&
          !entry.view.element.hidden,
      );
    }
    if (
      this.#state.selectedDiffKey &&
      this.#entries.get(this.#state.selectedDiffKey)?.view.element.hidden
    ) {
      this.#state.selectedDiffKey =
        [...this.#entries.entries()].find(
          ([, entry]) => !entry.view.element.hidden,
        )?.[0] ?? null;
    }
    this.#renderNavigation();
  }

  #renderNavigation(): void {
    const navigation = this.#navigationList;
    if (!navigation) return;
    navigation.replaceChildren();
    this.#navigationButtons.clear();
    const repositories = this.#snapshot?.repositories ?? [];
    for (const repository of repositories) {
      const matches = repository.files.filter((change) =>
        gitChangeMatchesFilter(repository, change, this.#filter),
      );
      if (this.#filter.trim() && matches.length === 0) continue;
      const section = document.createElement("section");
      section.className = "git-navigation-repository";
      const collapsed = this.#state.collapsedRepositoryIds.includes(
        repository.repositoryId,
      );
      const header = document.createElement("button");
      header.type = "button";
      header.className = "git-navigation-repository-header";
      header.setAttribute("aria-expanded", String(!collapsed));
      const chevron = document.createElement("span");
      chevron.className = "git-chevron";
      chevron.textContent = collapsed ? "▸" : "▾";
      const name = document.createElement("strong");
      name.textContent = repositoryLabel(repository);
      const branch = document.createElement("span");
      branch.className = "git-navigation-branch";
      branch.textContent = repository.branch ?? "detached";
      const count = document.createElement("span");
      count.className = "git-count";
      count.textContent = String(repository.files.length);
      header.append(chevron, name, branch, count);
      header.addEventListener("click", () =>
        this.#toggleRepository(repository.repositoryId),
      );
      section.append(header);

      if (!collapsed) {
        if (repository.error) {
          section.append(statusElement("git-error", repository.error));
        } else if (repository.files.length === 0) {
          section.append(statusElement("git-clean", "No changes"));
        } else if (matches.length === 0) {
          section.append(statusElement("git-empty", "No matching files"));
        } else {
          for (const change of matches) {
            const key = gitChangeKey(repository.repositoryId, change.path);
            const button = navigationFileButton(change);
            button.classList.toggle(
              "is-selected",
              key === this.#state.selectedDiffKey,
            );
            button.addEventListener("click", () => this.#revealDiff(key));
            this.#navigationButtons.set(key, button);
            section.append(button);
          }
        }
      }
      navigation.append(section);
    }
  }

  #toggleRepository(repositoryId: string): void {
    this.#state.collapsedRepositoryIds =
      this.#state.collapsedRepositoryIds.includes(repositoryId)
        ? this.#state.collapsedRepositoryIds.filter((id) => id !== repositoryId)
        : [...this.#state.collapsedRepositoryIds, repositoryId];
    this.#renderNavigation();
    this.#schedulePersistState();
  }

  #setDiffCollapsed(key: string, collapsed: boolean): void {
    this.#state.collapsedDiffKeys = collapsed
      ? [...new Set([...this.#state.collapsedDiffKeys, key])]
      : this.#state.collapsedDiffKeys.filter((value) => value !== key);
    const entry = this.#entries.get(key);
    entry?.view.setCollapsed(collapsed);
    if (entry && !collapsed) {
      this.#requestDiff(key, true);
      this.#scheduleDiffLayout();
    }
    this.#schedulePersistState();
  }

  #setDiffContentColumns(contentColumns: number): void {
    const next = Math.max(
      this.#diffContentColumns,
      DIFF_GUTTER_COLUMNS + contentColumns,
    );
    if (next === this.#diffContentColumns) return;
    this.#diffContentColumns = next;
    this.#diffList?.style.setProperty(
      "--git-diff-content-columns",
      String(next),
    );
  }

  #revealDiff(key: string): void {
    const entry = this.#entries.get(key);
    const pane = this.#diffPane;
    if (!entry || !pane || entry.view.element.hidden) return;
    this.#requestDiff(key, true);
    const paneBounds = pane.getBoundingClientRect();
    const fileBounds = entry.view.element.getBoundingClientRect();
    pane.scrollTop = Math.max(
      0,
      pane.scrollTop + fileBounds.top - paneBounds.top - 4,
    );
    this.#setSelectedDiff(key);
    entry.view.updateViewport(pane.getBoundingClientRect());
    entry.view.focusHeader();
    this.#scheduleDiffLayout();
  }

  #setSelectedDiff(key: string): void {
    if (this.#state.selectedDiffKey === key) return;
    const previousKey = this.#state.selectedDiffKey;
    this.#state.selectedDiffKey = key;
    if (previousKey && !this.#nearViewportKeys.has(previousKey)) {
      this.#entries.get(previousKey)?.view.clearViewport();
    }
    for (const [candidate, button] of this.#navigationButtons) {
      button.classList.toggle("is-selected", candidate === key);
    }
    this.#schedulePersistState();
  }

  readonly #onDiffScroll = (): void => {
    this.#scheduleDiffLayout();
  };

  readonly #onDiffIntersection = (
    intersections: readonly IntersectionObserverEntry[],
  ): void => {
    for (const intersection of intersections) {
      const element = intersection.target as HTMLElement;
      const key = this.#diffKeysByElement.get(element);
      if (!key || !this.#entries.has(key)) continue;
      if (intersection.isIntersecting) {
        this.#nearViewportKeys.add(key);
        const entry = this.#entries.get(key);
        if (entry && !entry.view.isCollapsed && !entry.view.element.hidden) {
          this.#requestDiff(key);
        }
      } else {
        this.#nearViewportKeys.delete(key);
        if (key !== this.#state.selectedDiffKey) {
          this.#entries.get(key)?.view.clearViewport();
        }
      }
    }
    this.#scheduleDiffLayout();
  };

  #scheduleDiffLayout(): void {
    this.#layoutScheduler.enqueue("git-diff-layout", () => {
      this.#updateDiffViewports();
      this.#syncSelectionFromScroll();
    });
  }

  #updateDiffViewports(): void {
    const pane = this.#diffPane;
    if (!pane) return;
    const bounds = pane.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const viewportKeys = new Set(this.#nearViewportKeys);
    if (this.#state.selectedDiffKey) {
      viewportKeys.add(this.#state.selectedDiffKey);
    }
    for (const key of viewportKeys) {
      this.#entries.get(key)?.view.updateViewport(bounds);
    }
  }

  #syncSelectionFromScroll(): void {
    const pane = this.#diffPane;
    if (!pane) return;
    const bounds = pane.getBoundingClientRect();
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.bottom <= 0 ||
      bounds.top >= window.innerHeight
    ) {
      return;
    }
    const target = document.elementFromPoint(
      Math.min(bounds.right - 1, bounds.left + 96),
      Math.min(bounds.bottom - 1, bounds.top + 40),
    );
    const file = target?.closest<HTMLElement>(".git-diff-file");
    const selected = file ? this.#diffKeysByElement.get(file) : undefined;
    if (selected) this.#setSelectedDiff(selected);
  }

  #schedulePersistState(): void {
    if (this.#persistTimer !== null) window.clearTimeout(this.#persistTimer);
    this.#persistTimer = window.setTimeout(() => {
      this.#persistTimer = null;
      this.#persistStateNow();
    }, 200);
  }

  #persistStateNow(): void {
    this.#tab.state = { ...this.#state };
    void this.#client.backend
      .updateTabState({
        tabId: this.#tab.id,
        title: this.#tab.title,
        stateVersion: 2,
        state: this.#state,
      })
      .catch((error) => {
        if (!this.#disposed) this.#setStatus(`state · ${describeError(error)}`);
      });
  }

  #setStatus(value: string): void {
    if (this.#status && this.#status.textContent !== value)
      this.#status.textContent = value;
  }
}

class GitDiffFileView {
  readonly element = document.createElement("article");
  readonly #header = document.createElement("button");
  readonly #body = document.createElement("div");
  readonly #topSpacer = document.createElement("div");
  readonly #rowWindow = document.createElement("div");
  readonly #bottomSpacer = document.createElement("div");
  readonly #chevron = document.createElement("span");
  readonly #additions = document.createElement("span");
  readonly #deletions = document.createElement("span");
  #lines: readonly GitDisplayLine[] | null = null;
  #diffPath = "";
  #windowStart = -1;
  #windowEnd = -1;
  #collapsed: boolean;
  #renderVersion = 0;
  #destroyed = false;

  get message(): string {
    return this.#body.textContent ?? "";
  }

  constructor(
    repository: GitRepositoryStatusDto,
    readonly change: GitFileChangeDto,
    collapsed: boolean,
    onCollapseChanged: (collapsed: boolean) => void,
  ) {
    this.#collapsed = collapsed;
    this.element.className = "git-diff-file";
    this.element.dataset.kind = change.kind;
    this.#header.type = "button";
    this.#header.className = "git-diff-file-header";
    this.#header.title = change.originalPath
      ? `${change.originalPath} → ${change.path}`
      : change.path;
    this.#chevron.className = "git-chevron";
    const icon = createFileResourceIcon(change.path);
    const identity = document.createElement("span");
    identity.className = "git-diff-file-identity";
    const name = document.createElement("strong");
    name.textContent = gitFileName(change.path);
    const parent = document.createElement("span");
    parent.className = "git-diff-file-parent";
    const parentPath = gitParentPath(change.path);
    parent.textContent = [
      repository.relativePath === "." ? "" : repository.relativePath,
      parentPath,
    ]
      .filter(Boolean)
      .join("/");
    identity.append(name, parent);
    const statistics = document.createElement("span");
    statistics.className = "git-diff-statistics";
    this.#additions.className = "git-diff-stat-additions";
    this.#deletions.className = "git-diff-stat-deletions";
    statistics.append(this.#additions, this.#deletions);
    this.#header.append(this.#chevron, icon, identity, statistics);
    this.#header.addEventListener("click", () =>
      onCollapseChanged(!this.#collapsed),
    );
    this.#body.className = "git-diff-file-body";
    this.#body.append(statusElement("git-diff-loading", "Loading diff…"));
    this.element.append(this.#header, this.#body);
    this.setCollapsed(collapsed);
  }

  get isCollapsed(): boolean {
    return this.#collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    this.#chevron.textContent = collapsed ? "▸" : "▾";
    this.#header.setAttribute("aria-expanded", String(!collapsed));
    this.#body.hidden = collapsed;
    if (collapsed) this.clearViewport();
  }

  focusHeader(): void {
    this.#header.focus({ preventScroll: true });
  }

  render(diff: GitFileDiffDto): number {
    this.#renderVersion += 1;
    this.#lines = null;
    this.#windowStart = -1;
    this.#windowEnd = -1;
    this.element.dataset.totalRows = "0";
    this.element.dataset.renderedRows = "0";
    this.#additions.textContent = diff.additions ? `+${diff.additions}` : "";
    this.#deletions.textContent = diff.deletions ? `−${diff.deletions}` : "";
    this.#body.replaceChildren();
    if (diff.binary) {
      this.#body.append(
        statusElement("git-diff-message", "Binary file changed"),
      );
      return 0;
    }
    if (diff.truncated) {
      this.#body.append(
        statusElement(
          "git-diff-message",
          "Diff exceeds the 4 MiB or 50,000-line display limit",
        ),
      );
      return 0;
    }
    const lines = flattenGitDiff(diff);
    if (lines.length === 0) {
      this.#body.append(
        statusElement(
          "git-diff-message",
          this.change.kind === "untracked"
            ? "Empty file"
            : "Metadata-only change or unchanged working content",
        ),
      );
      return 0;
    }
    this.#lines = lines;
    this.#diffPath = diff.path;
    this.element.dataset.totalRows = String(lines.length);
    this.#topSpacer.className = "git-diff-spacer";
    this.#topSpacer.setAttribute("aria-hidden", "true");
    this.#rowWindow.className = "git-diff-window";
    this.#bottomSpacer.className = "git-diff-spacer";
    this.#bottomSpacer.setAttribute("aria-hidden", "true");
    this.#bottomSpacer.style.height = `${lines.length * GIT_DIFF_ROW_HEIGHT}px`;
    this.#body.replaceChildren(
      this.#topSpacer,
      this.#rowWindow,
      this.#bottomSpacer,
    );
    return gitDiffContentColumns(lines);
  }

  updateViewport(paneBounds: DOMRect | null): void {
    const lines = this.#lines;
    if (!lines || this.#collapsed || !paneBounds) {
      this.clearViewport();
      return;
    }
    const bodyBounds = this.#body.getBoundingClientRect();
    const window = gitDiffVirtualWindow(
      lines.length,
      paneBounds.top - bodyBounds.top,
      paneBounds.bottom - bodyBounds.top,
    );
    this.#renderWindow(
      window.start,
      window.end,
      window.paddingBefore,
      window.paddingAfter,
    );
  }

  clearViewport(): void {
    const lines = this.#lines;
    if (!lines) return;
    this.#renderWindow(0, 0, 0, lines.length * GIT_DIFF_ROW_HEIGHT);
  }

  #renderWindow(
    start: number,
    end: number,
    paddingBefore: number,
    paddingAfter: number,
  ): void {
    const lines = this.#lines;
    if (!lines || (start === this.#windowStart && end === this.#windowEnd))
      return;
    this.#windowStart = start;
    this.#windowEnd = end;
    const version = ++this.#renderVersion;
    const codeCells: HTMLElement[] = [];
    const displayLines = lines.slice(start, end);
    const fragment = document.createDocumentFragment();
    for (const line of displayLines) {
      const row = document.createElement("div");
      row.className = `git-diff-row is-${line.kind}`;
      const oldNumber = document.createElement("span");
      oldNumber.className = "git-diff-line-number git-diff-old-line";
      oldNumber.textContent = line.oldLine?.toString() ?? "";
      const newNumber = document.createElement("span");
      newNumber.className = "git-diff-line-number git-diff-new-line";
      newNumber.textContent = line.newLine?.toString() ?? "";
      const marker = document.createElement("span");
      marker.className = "git-diff-marker";
      marker.textContent = diffMarker(line.kind);
      const code = document.createElement("code");
      code.className = "git-diff-code";
      code.textContent = line.content || " ";
      row.append(oldNumber, newNumber, marker, code);
      fragment.append(row);
      codeCells.push(code);
    }
    this.#topSpacer.style.height = `${paddingBefore}px`;
    this.#rowWindow.replaceChildren(fragment);
    this.#bottomSpacer.style.height = `${paddingAfter}px`;
    this.element.dataset.renderedRows = String(displayLines.length);
    void highlightDisplayLines(this.#diffPath, displayLines)
      .then((tokens) => {
        if (this.#destroyed || version !== this.#renderVersion) return;
        tokens.forEach((lineTokens, index) => {
          const line = displayLines[index];
          const cell = codeCells[index];
          if (!line || !cell || line.kind === "hunk" || line.kind === "meta")
            return;
          renderHighlightedText(cell, line.content, lineTokens);
        });
      })
      .catch(() => {
        // Plain diff text remains available when an optional language chunk fails.
      });
  }

  renderError(message: string): void {
    this.#renderVersion += 1;
    this.#lines = null;
    this.element.dataset.totalRows = "0";
    this.element.dataset.renderedRows = "0";
    this.#body.replaceChildren(statusElement("git-error", message));
  }

  destroy(): void {
    this.#destroyed = true;
    this.#renderVersion += 1;
  }
}

async function highlightDisplayLines(
  path: string,
  lines: readonly GitDisplayLine[],
): Promise<SyntaxToken[][]> {
  const tokens = lines.map(() => [] as SyntaxToken[]);
  const description = LanguageDescription.matchFilename(languages, path);
  if (!description) return tokens;
  const support = description.support ?? (await description.load());
  const sourceLines = lines.map((line) =>
    line.kind === "hunk" || line.kind === "meta" ? "" : line.content,
  );
  const starts: number[] = [];
  let offset = 0;
  for (const line of sourceLines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const source = sourceLines.join("\n");
  const tree = support.language.parser.parse(source);
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    let cursor = from;
    while (cursor < to) {
      const index = lineIndexAt(starts, cursor);
      const lineStart = starts[index] ?? 0;
      const lineEnd = lineStart + (sourceLines[index]?.length ?? 0);
      const end = Math.min(to, lineEnd);
      if (end > cursor) {
        tokens[index]?.push({
          from: cursor - lineStart,
          to: end - lineStart,
          classes,
        });
      }
      cursor = end > cursor ? end : cursor + 1;
      if (cursor === lineEnd && cursor < to) cursor += 1;
    }
  });
  return tokens;
}

function lineIndexAt(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function renderHighlightedText(
  element: HTMLElement,
  content: string,
  tokens: readonly SyntaxToken[],
): void {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const token of tokens) {
    const from = Math.max(offset, Math.min(token.from, content.length));
    const to = Math.max(from, Math.min(token.to, content.length));
    if (from > offset)
      fragment.append(document.createTextNode(content.slice(offset, from)));
    if (to > from) {
      const span = document.createElement("span");
      span.className = token.classes;
      span.textContent = content.slice(from, to);
      fragment.append(span);
    }
    offset = to;
  }
  if (offset < content.length)
    fragment.append(document.createTextNode(content.slice(offset)));
  if (content.length === 0) fragment.append(document.createTextNode(" "));
  element.replaceChildren(fragment);
}

function navigationFileButton(change: GitFileChangeDto): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `git-navigation-file status-${change.kind}`;
  const pathLabel = change.originalPath
    ? `${change.originalPath} → ${change.path}`
    : change.path;
  button.title = `${pathLabel} · ${change.kind}`;
  const icon = createFileResourceIcon(change.path);
  const identity = document.createElement("span");
  identity.className = "git-navigation-file-identity";
  const name = document.createElement("strong");
  name.textContent = gitFileName(change.path);
  const parent = document.createElement("span");
  parent.textContent = gitParentPath(change.path);
  identity.append(name, parent);
  const status = document.createElement("span");
  status.className = "git-navigation-file-status";
  status.textContent = gitChangeBadge(change);
  status.setAttribute("aria-hidden", "true");
  button.append(icon, identity, status);
  return button;
}

function statusElement(className: string, message: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = message;
  return element;
}

function repositoryLabel(repository: GitRepositoryStatusDto): string {
  return repository.relativePath === "."
    ? "Root repository"
    : repository.relativePath;
}

function diffMarker(kind: GitDisplayLine["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "deleted") return "−";
  if (kind === "meta") return "\\";
  return "";
}

function changeCount(snapshot: GitSnapshotDto): number {
  return snapshot.repositories.reduce(
    (total, repository) => total + repository.files.length,
    0,
  );
}

function parseState(value: unknown): GitTabState {
  const state =
    value && typeof value === "object" ? (value as Partial<GitTabState>) : {};
  return {
    collapsedRepositoryIds: stringArray(state.collapsedRepositoryIds),
    collapsedDiffKeys: stringArray(state.collapsedDiffKeys),
    selectedDiffKey:
      typeof state.selectedDiffKey === "string" ? state.selectedDiffKey : null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing Changes element: ${selector}`);
  return element;
}

type GitDebugElement = HTMLElement & {
  __CCSM_GIT_DEBUG__?: () => {
    files: Array<{
      path: string;
      loadState: GitDiffEntry["loadState"];
      totalRows: number;
      renderedRows: number;
      message: string;
    }>;
  };
};
