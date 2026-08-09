import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import { BackgroundScanController } from "../background-scan";
import type { GitRepositoryStatusDto } from "../generated/GitRepositoryStatusDto";
import type { GitSnapshotDto } from "../generated/GitSnapshotDto";
import type { TabDto } from "../generated/TabDto";
import { gitChangeNeedsScan } from "../scan-routing";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

interface GitTabState {
  collapsedRepositoryIds: string[];
}

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
  #state: GitTabState;
  #snapshot: GitSnapshotDto | null = null;
  #content: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #disposed = false;
  #unlisten: (() => void) | null = null;
  readonly #scanner: BackgroundScanController;

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
        <strong>Source Control</strong>
        <span class="git-status">loading cache</span>
        <button class="git-refresh" type="button">Refresh</button>
      </div>
      <div class="git-sections"></div>
    `;
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    this.#content = this.element.querySelector(".git-sections");
    this.#status = this.element.querySelector(".git-status");
    this.element
      .querySelector(".git-refresh")
      ?.addEventListener("click", () => {
        this.#scanner.request(true);
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
    this.#content?.focus();
  }
  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    this.#scanner.dispose();
  }

  async #initialize(): Promise<void> {
    try {
      this.#snapshot = await this.#client.backend.cachedGit(this.#tab.spaceId);
      this.#render();
    } catch {
      // Empty or stale cache is reconciled by the refresh below.
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
    const changes = snapshot.repositories.reduce(
      (total, repository) => total + repository.files.length,
      0,
    );
    this.#setStatus(
      `${snapshot.repositories.length} repos · ${changes} changes`,
    );
  }

  #render(): void {
    if (!this.#content) return;
    this.#content.replaceChildren();
    const repositories = this.#snapshot?.repositories ?? [];
    if (repositories.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty";
      empty.textContent =
        "No repositories found at the Space root or its direct children.";
      this.#content.append(empty);
      return;
    }
    for (const repository of repositories) {
      this.#content.append(this.#renderRepository(repository));
    }
  }

  #renderRepository(repository: GitRepositoryStatusDto): HTMLElement {
    const section = document.createElement("section");
    section.className = "git-repository";
    const collapsed = this.#state.collapsedRepositoryIds.includes(
      repository.repositoryId,
    );
    const header = document.createElement("button");
    header.type = "button";
    header.className = "git-repository-header";
    header.setAttribute(
      "aria-label",
      `${collapsed ? "Expand" : "Collapse"} repository ${repository.relativePath}`,
    );
    const title =
      repository.relativePath === "."
        ? "Root repository"
        : repository.relativePath;
    header.innerHTML = `
      <span>${collapsed ? "▸" : "▾"}</span>
      <strong></strong>
      <span class="git-branch"></span>
      <span class="git-count"></span>
    `;
    header.querySelector("strong")!.textContent = title;
    header.querySelector(".git-branch")!.textContent =
      repository.branch ?? "detached";
    header.querySelector(".git-count")!.textContent = String(
      repository.files.length,
    );
    header.addEventListener(
      "click",
      () => void this.#toggleRepository(repository.repositoryId),
    );
    section.append(header);
    if (!collapsed) {
      if (repository.error) {
        const error = document.createElement("div");
        error.className = "git-error";
        error.textContent = repository.error;
        section.append(error);
      } else if (repository.files.length === 0) {
        const clean = document.createElement("div");
        clean.className = "git-clean";
        clean.textContent = "No changes";
        section.append(clean);
      } else {
        for (const file of repository.files) {
          const row = document.createElement("div");
          row.className = "git-file";
          row.title = file.originalPath
            ? `${file.originalPath} → ${file.path}`
            : file.path;
          const status = document.createElement("span");
          status.className = `git-file-status status-${file.kind}`;
          status.textContent = `${file.indexStatus || " "}${file.worktreeStatus || " "}`;
          const path = document.createElement("span");
          path.className = "git-file-path";
          path.textContent = file.path;
          row.append(status, path);
          section.append(row);
        }
      }
    }
    return section;
  }

  async #toggleRepository(repositoryId: string): Promise<void> {
    this.#state.collapsedRepositoryIds =
      this.#state.collapsedRepositoryIds.includes(repositoryId)
        ? this.#state.collapsedRepositoryIds.filter((id) => id !== repositoryId)
        : [...this.#state.collapsedRepositoryIds, repositoryId];
    this.#render();
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

function parseState(value: unknown): GitTabState {
  if (value && typeof value === "object") {
    const state = value as Partial<GitTabState>;
    if (Array.isArray(state.collapsedRepositoryIds)) {
      return {
        collapsedRepositoryIds: state.collapsedRepositoryIds.filter(
          (id): id is string => typeof id === "string",
        ),
      };
    }
  }
  return { collapsedRepositoryIds: [] };
}
