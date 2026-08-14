import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import { createFileResourceIcon } from "../file-resource-icon";
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
}

interface SyntaxToken {
  from: number;
  to: number;
  classes: string;
}

const DIFF_CHUNK_SIZE = 64;
const DIFF_ROW_BLOCK_SIZE = 20;
const DIFF_GUTTER_COLUMNS = 22;

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
  #loadGeneration = 0;
  #scrollFrame: number | null = null;
  #persistTimer: number | null = null;
  #diffContentColumns = DIFF_GUTTER_COLUMNS;

  constructor(tab: TabDto, client: CcsmDesktopClient) {
    this.#tab = tab;
    this.#client = client;
    this.#state = parseState(tab.state);
    this.#scanner = new BackgroundScanController(
      (manual) => this.#refresh(manual),
      (error) => {
        if (!this.#disposed)
          this.#setStatus(`paused · ${describeError(error)}`);
      },
      {
        maxBurstRuns: 1,
        cooldownMs: 3_000,
        failureThreshold: 2,
        failureCooldownMs: 15_000,
        timeoutMs: 10_000,
      },
    );
    this.element.className = "git-panel";
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

  init(_parameters: GroupPanelPartInitParameters): void {
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
    this.element
      .querySelector(".git-refresh")
      ?.addEventListener("click", () => this.#scanner.request(true));
    filterInput.addEventListener("input", () => {
      this.#filter = filterInput.value;
      this.#applyFilter();
    });
    diffPane.addEventListener("scroll", this.#onDiffScroll, {
      passive: true,
    });
    void this.#client.events
      .subscribe((event) => {
        if (
          event.kind === "filesystem.changed" &&
          gitChangeNeedsScan(event.payload, this.#snapshot)
        ) {
          this.#scanner.request();
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
    this.#unlisten = null;
    this.#scanner.dispose();
    if (this.#scrollFrame !== null) cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = null;
    if (this.#persistTimer !== null) {
      window.clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
      this.#persistStateNow();
    }
    for (const entry of this.#entries.values()) entry.view.destroy();
    this.#entries.clear();
  }

  async #initialize(): Promise<void> {
    try {
      this.#snapshot = await this.#client.backend.cachedGit(this.#tab.spaceId);
      this.#render();
    } catch {
      // The refresh below reconciles an empty or stale cache.
    }
    this.#scanner.request(true);
  }

  async #refresh(manual: boolean): Promise<void> {
    if (manual) this.#setStatus("scanning");
    const snapshot = await this.#client.backend.refreshGit({
      spaceId: this.#tab.spaceId,
    });
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#render();
    const changes = changeCount(snapshot);
    this.#setStatus(
      `${snapshot.repositories.length} repos · ${changes} changes`,
    );
  }

  #render(): void {
    const diffList = this.#diffList;
    const diffPane = this.#diffPane;
    if (!diffList || !diffPane) return;
    const previousScrollTop = diffPane.scrollTop;
    const generation = ++this.#loadGeneration;
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
          this.#entries.set(key, { repository, change, view });
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
    requestAnimationFrame(() => {
      if (generation !== this.#loadGeneration || this.#disposed) return;
      if (this.#diffPane) this.#diffPane.scrollTop = previousScrollTop;
      this.#syncSelectionFromScroll();
    });
    void this.#loadDiffs(generation);
  }

  async #loadDiffs(generation: number): Promise<void> {
    const queue = [...this.#entries.entries()];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        if (!item) return;
        const [key, entry] = item;
        try {
          const diff = await this.#client.backend.readGitDiff({
            spaceId: this.#tab.spaceId,
            repositoryId: entry.repository.repositoryId,
            path: entry.change.path,
          });
          if (
            this.#disposed ||
            generation !== this.#loadGeneration ||
            this.#entries.get(key) !== entry
          ) {
            return;
          }
          this.#setDiffContentColumns(entry.view.render(diff));
        } catch (error) {
          if (
            this.#disposed ||
            generation !== this.#loadGeneration ||
            this.#entries.get(key) !== entry
          ) {
            return;
          }
          entry.view.renderError(describeError(error));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, () => worker()),
    );
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
    this.#entries.get(key)?.view.setCollapsed(collapsed);
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
    const paneBounds = pane.getBoundingClientRect();
    const fileBounds = entry.view.element.getBoundingClientRect();
    pane.scrollTo({
      top: pane.scrollTop + fileBounds.top - paneBounds.top - 4,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    this.#setSelectedDiff(key);
    entry.view.focusHeader();
  }

  #setSelectedDiff(key: string): void {
    if (this.#state.selectedDiffKey === key) return;
    this.#state.selectedDiffKey = key;
    for (const [candidate, button] of this.#navigationButtons) {
      button.classList.toggle("is-selected", candidate === key);
    }
    this.#schedulePersistState();
  }

  readonly #onDiffScroll = (): void => {
    if (this.#scrollFrame !== null) return;
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null;
      this.#syncSelectionFromScroll();
    });
  };

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
  readonly #chevron = document.createElement("span");
  readonly #additions = document.createElement("span");
  readonly #deletions = document.createElement("span");
  #collapsed: boolean;
  #renderVersion = 0;
  #destroyed = false;

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

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    this.#chevron.textContent = collapsed ? "▸" : "▾";
    this.#header.setAttribute("aria-expanded", String(!collapsed));
    this.#body.hidden = collapsed;
  }

  focusHeader(): void {
    this.#header.focus({ preventScroll: true });
  }

  render(diff: GitFileDiffDto): number {
    const version = ++this.#renderVersion;
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
          "Diff exceeds the 4 MiB display limit",
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
    const codeCells: HTMLElement[] = [];
    const fragment = document.createDocumentFragment();
    let chunk: HTMLElement | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (index % DIFF_CHUNK_SIZE === 0) {
        const chunkLineCount = Math.min(DIFF_CHUNK_SIZE, lines.length - index);
        chunk = document.createElement("div");
        chunk.className = "git-diff-chunk";
        chunk.style.setProperty(
          "--git-diff-chunk-block-size",
          `${chunkLineCount * DIFF_ROW_BLOCK_SIZE}px`,
        );
        fragment.append(chunk);
      }
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
      chunk?.append(row);
      codeCells.push(code);
    }
    this.#body.append(fragment);
    void highlightDisplayLines(diff.path, lines)
      .then((tokens) => {
        if (this.#destroyed || version !== this.#renderVersion) return;
        tokens.forEach((lineTokens, index) => {
          const line = lines[index];
          const cell = codeCells[index];
          if (!line || !cell || line.kind === "hunk" || line.kind === "meta")
            return;
          renderHighlightedText(cell, line.content, lineTokens);
        });
      })
      .catch(() => {
        // Plain diff text remains available when an optional language chunk fails.
      });
    return gitDiffContentColumns(lines);
  }

  renderError(message: string): void {
    this.#renderVersion += 1;
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
