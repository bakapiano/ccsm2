import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { BoardChangedDto } from "../generated/BoardChangedDto";
import type { BoardDocumentDto } from "../generated/BoardDocumentDto";
import type { TabDto } from "../generated/TabDto";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import { uiIcon } from "../ui-icons";
import type { TabProvider } from "./registry";

interface BoardTabState {
  boardId: string;
  revision?: string;
}

interface BoardDebugSnapshot {
  boardId: string;
  title: string;
  revision: string | null;
  htmlLength: number;
  loaded: boolean;
  status: string;
  interactionState: string | null;
}

interface BoardDebugElement extends HTMLElement {
  __CCSM_BOARD_DEBUG__?: () => BoardDebugSnapshot;
}

export class BoardTabProvider implements TabProvider {
  readonly kind = "board" as const;
  readonly #panels = new Set<BoardPanel>();
  #unlisten: (() => void) | null = null;
  #destroyed = false;

  constructor(private readonly client: CcsmDesktopClient) {
    void client.events
      .subscribe((event) => {
        if (event.kind !== "board.changed") return;
        for (const panel of this.#panels)
          panel.handleBoardChanged(event.payload);
      })
      .then((unlisten) => {
        if (this.#destroyed) unlisten();
        else this.#unlisten = unlisten;
      });
  }

  createRenderer(tab: TabDto): IContentRenderer {
    const panel = new BoardPanel(tab, this.client, () =>
      this.#panels.delete(panel),
    );
    this.#panels.add(panel);
    return panel;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#unlisten?.();
    this.#unlisten = null;
  }
}

class BoardPanel implements IContentRenderer {
  readonly element = document.createElement("section") as BoardDebugElement;
  readonly #boardId: string;
  #frame: HTMLIFrameElement | null = null;
  #status: HTMLElement | null = null;
  #document: BoardDocumentDto | null = null;
  #disposed = false;
  #loadSequence = 0;
  #interactionState: string | null = null;

  constructor(
    private readonly tab: TabDto,
    private readonly client: CcsmDesktopClient,
    private readonly onDispose: () => void,
  ) {
    this.#boardId = tab.resourceId ?? parseState(tab.state).boardId;
    this.element.className = "board-panel";
    this.element.dataset.boardId = this.#boardId;
    this.element.dataset.status = "loading";
    this.element.innerHTML = `
      <div class="board-toolbar panel-toolbar">
        <strong class="board-title">${escapeHtml(tab.title)}</strong>
        <span class="board-status panel-status">Loading…</span>
        <button class="board-reload control-button control-button-icon" type="button" aria-label="Reload board" title="Reload board">
          ${uiIcon("refresh")}
        </button>
      </div>
      <iframe class="board-frame" title="${escapeHtml(tab.title)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>
    `;
    this.element.__CCSM_BOARD_DEBUG__ = () => ({
      boardId: this.#boardId,
      title: this.#document?.title ?? this.tab.title,
      revision: this.#document?.revision ?? null,
      htmlLength: this.#document?.html.length ?? 0,
      loaded: Boolean(this.#document),
      status: this.element.dataset.status ?? "unknown",
      interactionState: this.#interactionState,
    });
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    this.#frame = this.element.querySelector(".board-frame");
    this.#status = this.element.querySelector(".board-status");
    this.element
      .querySelector(".board-reload")
      ?.addEventListener("click", () => {
        void this.#load();
      });
    window.addEventListener("message", this.#onMessage);
    void this.#load();
  }

  dispose(): void {
    this.#disposed = true;
    this.#loadSequence += 1;
    window.removeEventListener("message", this.#onMessage);
    delete this.element.__CCSM_BOARD_DEBUG__;
    this.onDispose();
  }

  handleBoardChanged(change: BoardChangedDto): void {
    if (
      change.board.spaceId !== this.tab.spaceId ||
      change.board.id !== this.#boardId
    )
      return;
    void this.#load();
  }

  readonly #onMessage = (event: MessageEvent): void => {
    if (event.source !== this.#frame?.contentWindow) return;
    if (
      !event.data ||
      typeof event.data !== "object" ||
      event.data.type !== "ccsm:board-state" ||
      typeof event.data.state !== "string"
    )
      return;
    const state = event.data.state.slice(0, 160);
    this.#interactionState = state;
    this.element.dataset.interactionState = state;
  };

  async #load(): Promise<void> {
    const request = ++this.#loadSequence;
    this.#setStatus("loading", "Loading…");
    try {
      const document = await this.client.backend.readBoard({
        spaceId: this.tab.spaceId,
        boardId: this.#boardId,
      });
      if (this.#disposed || request !== this.#loadSequence) return;
      this.#document = document;
      const title = this.element.querySelector(".board-title");
      if (title) title.textContent = document.title;
      if (this.#frame) {
        this.#frame.title = document.title;
        this.#frame.srcdoc = document.html;
      }
      this.#setStatus("ready", "Interactive HTML");
    } catch (error) {
      if (this.#disposed || request !== this.#loadSequence) return;
      this.#setStatus("error", describeError(error));
    }
  }

  #setStatus(state: string, message: string): void {
    this.element.dataset.status = state;
    if (this.#status) this.#status.textContent = message;
  }
}

function parseState(value: unknown): BoardTabState {
  if (!value || typeof value !== "object") return { boardId: "" };
  const state = value as { boardId?: unknown; revision?: unknown };
  return {
    boardId: typeof state.boardId === "string" ? state.boardId : "",
    revision: typeof state.revision === "string" ? state.revision : undefined,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
