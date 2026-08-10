import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import {
  showFileEditorDialog,
  type FileEditorDialogOptions,
} from "../file-editor-dialog";
import {
  fileChangeAffectsPath,
  fileName,
  findBracketMatch,
  highlightSource,
  languageForPath,
  lineAndColumn,
  parseFileEditorState,
  type FileEditorTabState,
} from "../file-editor-model";
import type { FileDocumentDto } from "../generated/FileDocumentDto";
import type { FileLineEnding } from "../generated/FileLineEnding";
import type { TabDto } from "../generated/TabDto";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

type EditorStatus =
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "conflict"
  | "read-only"
  | "error";

export interface FileEditorProviderOptions {
  presentationChanged(): void;
  setDialogVisible(visible: boolean): Promise<void>;
}

interface SessionSnapshot {
  status: EditorStatus;
  content: string;
  relativePath: string;
  message: string | null;
  notice: string | null;
  canEdit: boolean;
  canSave: boolean;
  syntaxHighlighting: boolean;
  utf8Bom: boolean;
  lineEnding: FileLineEnding;
  state: FileEditorTabState;
}

export class FileEditorTabProvider implements TabProvider {
  readonly kind = "file-editor" as const;
  readonly #sessions = new Map<string, FileEditorSession>();

  constructor(
    private readonly client: CcsmDesktopClient,
    private readonly options: FileEditorProviderOptions,
  ) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return new FileEditorPanel(this.#session(tab));
  }

  isDirty(tabId: string): boolean {
    return this.#sessions.get(tabId)?.isDirty() ?? false;
  }

  async requestClose(tab: TabDto): Promise<boolean> {
    const session = this.#sessions.get(tab.id);
    if (!session?.isDirty()) return true;
    const choice = await this.#prompt({
      title: `Save changes to ${fileName(session.relativePath)}?`,
      message: "Your changes will be lost if you discard them.",
      actions: [
        { id: "save", label: "Save", primary: true },
        { id: "discard", label: "Discard", danger: true },
        { id: "cancel", label: "Cancel" },
      ] as const,
      cancelAction: "cancel" as const,
    });
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    await session.save();
    return !session.isDirty();
  }

  async requestCloseMany(tabs: readonly TabDto[]): Promise<boolean> {
    const sessions = tabs
      .map((tab) => this.#sessions.get(tab.id))
      .filter((session): session is FileEditorSession =>
        Boolean(session?.isDirty()),
      );
    if (sessions.length === 0) return true;
    const choice = await this.#prompt({
      title: "Save changes before closing?",
      message: `${sessions.length} files have unsaved changes.`,
      files: sessions.map((session) => session.relativePath),
      actions: [
        { id: "save-all", label: "Save All", primary: true },
        { id: "discard-all", label: "Discard All", danger: true },
        { id: "cancel", label: "Cancel" },
      ] as const,
      cancelAction: "cancel" as const,
    });
    if (choice === "cancel") return false;
    if (choice === "discard-all") return true;
    for (const session of sessions) await session.save();
    return sessions.every((session) => !session.isDirty());
  }

  async requestCloseAll(): Promise<boolean> {
    const sessions = [...this.#sessions.values()].filter((session) =>
      session.isDirty(),
    );
    if (sessions.length === 0) return true;
    const choice = await this.#prompt({
      title: "Save changes before closing?",
      message: `${sessions.length} files have unsaved changes.`,
      files: sessions.map((session) => session.relativePath),
      actions: [
        { id: "save-all", label: "Save All", primary: true },
        { id: "discard-all", label: "Discard All", danger: true },
        { id: "cancel", label: "Cancel" },
      ] as const,
      cancelAction: "cancel" as const,
    });
    if (choice === "cancel") return false;
    if (choice === "discard-all") return true;
    for (const session of sessions) await session.save();
    return sessions.every((session) => !session.isDirty());
  }

  releaseTab(tabId: string): void {
    this.#sessions.get(tabId)?.dispose();
    this.#sessions.delete(tabId);
    this.options.presentationChanged();
  }

  destroyAll(): void {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
  }

  #session(tab: TabDto): FileEditorSession {
    let session = this.#sessions.get(tab.id);
    if (!session) {
      session = new FileEditorSession(
        tab,
        this.client,
        () => this.options.presentationChanged(),
        (options) => this.#prompt(options),
      );
      this.#sessions.set(tab.id, session);
    }
    return session;
  }

  async #prompt<T extends string>(
    options: FileEditorDialogOptions<T>,
  ): Promise<T> {
    await this.options.setDialogVisible(true);
    try {
      return await showFileEditorDialog(options);
    } finally {
      await this.options.setDialogVisible(false);
    }
  }
}

class FileEditorSession {
  readonly relativePath: string;
  readonly #viewState: FileEditorTabState;
  readonly #listeners = new Set<() => void>();
  #status: EditorStatus = "loading";
  #content = "";
  #diskContent = "";
  #revision: string | null = null;
  #utf8Bom = false;
  #lineEnding: FileLineEnding = "lf";
  #syntaxHighlighting = false;
  #message: string | null = null;
  #notice: string | null = null;
  #deleted = false;
  #history = [""];
  #historyIndex = 0;
  #mounted = 0;
  #unlisten: (() => void) | null = null;
  #persistTimer: number | null = null;
  #noticeTimer: number | null = null;
  #loadPromise: Promise<void> | null = null;
  #disposed = false;

  constructor(
    private readonly tab: TabDto,
    private readonly client: CcsmDesktopClient,
    private readonly presentationChanged: () => void,
    private readonly prompt: <T extends string>(
      options: FileEditorDialogOptions<T>,
    ) => Promise<T>,
  ) {
    this.#viewState = parseFileEditorState(tab);
    this.relativePath = this.#viewState.relativePath;
  }

  attach(): void {
    this.#mounted += 1;
    if (this.#mounted === 1) {
      void this.client.events
        .subscribe((event) => {
          if (
            event.kind === "filesystem.changed" &&
            fileChangeAffectsPath(event.payload, this.relativePath)
          ) {
            void this.#handleExternalChange();
          }
        })
        .then((unlisten) => {
          if (this.#disposed || this.#mounted === 0) unlisten();
          else this.#unlisten = unlisten;
        });
    }
    if (!this.#loadPromise && this.#status === "loading") {
      this.#loadPromise = this.#load(false).finally(() => {
        this.#loadPromise = null;
      });
    }
  }

  detach(): void {
    this.#mounted = Math.max(0, this.#mounted - 1);
    if (this.#mounted === 0) {
      this.#unlisten?.();
      this.#unlisten = null;
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    listener();
    return () => this.#listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    return {
      status: this.#status,
      content: this.#content,
      relativePath: this.relativePath,
      message: this.#message,
      notice: this.#notice,
      canEdit: !["loading", "saving", "read-only"].includes(this.#status),
      canSave:
        this.isDirty() &&
        !["loading", "saving", "read-only"].includes(this.#status),
      syntaxHighlighting: this.#syntaxHighlighting,
      utf8Bom: this.#utf8Bom,
      lineEnding: this.#lineEnding,
      state: { ...this.#viewState },
    };
  }

  isDirty(): boolean {
    return this.#content !== this.#diskContent;
  }

  setContent(content: string, recordHistory: boolean): void {
    if (content === this.#content) return;
    const wasDirty = this.isDirty();
    this.#content = content;
    if (recordHistory) this.recordHistory();
    if (this.#status !== "conflict" && this.#status !== "read-only") {
      this.#status = this.isDirty() ? "dirty" : "clean";
      this.#message = null;
    }
    this.#emit(wasDirty);
  }

  recordHistory(): void {
    if (this.#history[this.#historyIndex] === this.#content) return;
    this.#history.splice(this.#historyIndex + 1);
    this.#history.push(this.#content);
    this.#historyIndex = this.#history.length - 1;
  }

  undo(): void {
    if (this.#historyIndex <= 0) return;
    const wasDirty = this.isDirty();
    this.#historyIndex -= 1;
    this.#content = this.#history[this.#historyIndex] ?? "";
    if (this.#status !== "conflict" && this.#status !== "read-only")
      this.#status = this.isDirty() ? "dirty" : "clean";
    this.#emit(wasDirty);
  }

  redo(): void {
    if (this.#historyIndex >= this.#history.length - 1) return;
    const wasDirty = this.isDirty();
    this.#historyIndex += 1;
    this.#content = this.#history[this.#historyIndex] ?? "";
    if (this.#status !== "conflict" && this.#status !== "read-only")
      this.#status = this.isDirty() ? "dirty" : "clean";
    this.#emit(wasDirty);
  }

  updateViewState(
    values: Partial<Omit<FileEditorTabState, "relativePath">>,
  ): void {
    Object.assign(this.#viewState, values);
    this.tab.state = { ...this.#viewState };
    if (this.#persistTimer !== null) window.clearTimeout(this.#persistTimer);
    this.#persistTimer = window.setTimeout(() => {
      this.#persistTimer = null;
      void this.client.backend
        .updateTabState({
          tabId: this.tab.id,
          title: this.tab.title,
          stateVersion: 1,
          state: this.#viewState,
        })
        .catch((error) => {
          this.#message = `view state · ${describeError(error)}`;
          this.#emit();
        });
    }, 250);
  }

  async save(): Promise<void> {
    if (
      !this.isDirty() ||
      ["loading", "saving", "read-only"].includes(this.#status)
    )
      return;
    if (this.#status === "conflict") {
      await this.#resolveConflict();
      return;
    }
    await this.#performSave(false, false);
  }

  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    this.#unlisten = null;
    if (this.#persistTimer !== null) window.clearTimeout(this.#persistTimer);
    if (this.#noticeTimer !== null) window.clearTimeout(this.#noticeTimer);
    this.#listeners.clear();
  }

  async #load(external: boolean, discardLocal = false): Promise<void> {
    try {
      const document = await this.client.backend.readFile({
        spaceId: this.tab.spaceId,
        relativePath: this.relativePath,
      });
      if (this.#disposed) return;
      if (external && document.revision === this.#revision) return;
      if (external && this.isDirty() && !discardLocal) {
        this.#status = "conflict";
        this.#message = "File changed on disk. Your local edits are preserved.";
        this.#emit();
        return;
      }
      this.#applyDocument(document, external ? "File changed on disk" : null);
    } catch (error) {
      if (this.#disposed) return;
      if (isNotFound(error)) {
        this.#deleted = true;
        if (this.isDirty()) {
          this.#status = "conflict";
          this.#message =
            "File no longer exists on disk. Save can recreate it.";
        } else {
          this.#status = "read-only";
          this.#message = "File no longer exists on disk.";
        }
      } else {
        this.#status = this.isDirty() ? "dirty" : "error";
        this.#message = describeError(error);
      }
      this.#emit();
    }
  }

  #applyDocument(document: FileDocumentDto, notice: string | null): void {
    const wasDirty = this.isDirty();
    this.#revision = document.revision;
    this.#utf8Bom = document.utf8Bom;
    this.#lineEnding = document.lineEnding;
    this.#syntaxHighlighting = document.syntaxHighlighting;
    this.#deleted = false;
    this.#message = document.reason;
    this.#notice = notice;
    const content = document.content ?? "";
    this.#content = content;
    this.#diskContent = content;
    this.#history = [content];
    this.#historyIndex = 0;
    this.#status =
      document.status === "editable"
        ? "clean"
        : document.status === "read-only"
          ? "read-only"
          : "read-only";
    this.#emit(wasDirty);
    if (notice) this.#clearNoticeLater();
  }

  async #handleExternalChange(): Promise<void> {
    if (this.#status === "saving") return;
    if (!this.isDirty()) {
      await this.#load(true);
      return;
    }
    try {
      const document = await this.client.backend.readFile({
        spaceId: this.tab.spaceId,
        relativePath: this.relativePath,
      });
      if (document.revision === this.#revision) return;
      if (document.status === "read-only") {
        this.#status = "read-only";
        this.#message = document.reason ?? "File is read-only.";
      } else {
        this.#status = "conflict";
        this.#message = "File changed on disk. Your local edits are preserved.";
      }
      this.#deleted = false;
      this.#emit();
    } catch (error) {
      if (isNotFound(error)) {
        this.#deleted = true;
        this.#status = "conflict";
        this.#message = "File no longer exists on disk. Save can recreate it.";
      } else {
        this.#message = describeError(error);
      }
      this.#emit();
    }
  }

  async #resolveConflict(): Promise<void> {
    const choice = await this.prompt({
      title: this.#deleted ? "Recreate file?" : "File changed on disk",
      message: this.#deleted
        ? "The file was deleted outside CCSM. Recreate it with your local content?"
        : "Choose which version to keep.",
      actions: [
        {
          id: "overwrite",
          label: this.#deleted ? "Recreate" : "Overwrite",
          primary: true,
        },
        { id: "reload", label: "Reload from Disk", danger: true },
        { id: "cancel", label: "Cancel" },
      ] as const,
      cancelAction: "cancel" as const,
    });
    if (choice === "cancel") return;
    if (choice === "reload") {
      if (this.#deleted) {
        const wasDirty = this.isDirty();
        this.#content = this.#diskContent;
        this.#history = [this.#content];
        this.#historyIndex = 0;
        this.#emit(wasDirty);
      }
      await this.#load(true, true);
      return;
    }
    await this.#performSave(true, this.#deleted);
  }

  async #performSave(overwrite: boolean, recreate: boolean): Promise<void> {
    const wasDirty = this.isDirty();
    const savedContent = this.#content;
    this.#status = "saving";
    this.#message = null;
    this.#emit(wasDirty);
    try {
      const result = await this.client.backend.writeFile({
        spaceId: this.tab.spaceId,
        relativePath: this.relativePath,
        content: savedContent,
        expectedRevision: this.#revision,
        utf8Bom: this.#utf8Bom,
        lineEnding: this.#lineEnding,
        overwrite,
        recreate,
      });
      this.#revision = result.revision;
      this.#diskContent = savedContent;
      this.#deleted = false;
      this.#status = this.isDirty() ? "dirty" : "clean";
      this.#notice = "Saved";
      this.#emit(wasDirty);
      this.#clearNoticeLater();
    } catch (error) {
      if (isConflict(error)) {
        this.#status = "conflict";
        this.#message = describeError(error);
        this.#emit();
        await this.#resolveConflict();
      } else {
        this.#status = "dirty";
        this.#message = describeError(error);
        this.#emit();
      }
    }
  }

  #clearNoticeLater(): void {
    if (this.#noticeTimer !== null) window.clearTimeout(this.#noticeTimer);
    this.#noticeTimer = window.setTimeout(() => {
      this.#notice = null;
      this.#noticeTimer = null;
      this.#emit();
    }, 1_800);
  }

  #emit(previousDirty = this.isDirty()): void {
    for (const listener of this.#listeners) listener();
    if (previousDirty !== this.isDirty()) this.presentationChanged();
  }
}

class FileEditorPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #textarea: HTMLTextAreaElement;
  readonly #highlight: HTMLElement;
  readonly #lineNumbers: HTMLElement;
  readonly #currentLine: HTMLElement;
  readonly #banner: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #position: HTMLElement;
  readonly #format: HTMLElement;
  readonly #status: HTMLElement;
  readonly #searchPanel: HTMLElement;
  readonly #searchInput: HTMLInputElement;
  readonly #replaceInput: HTMLInputElement;
  readonly #searchResult: HTMLElement;
  readonly #gotoForm: HTMLFormElement;
  readonly #gotoInput: HTMLInputElement;
  #unsubscribe: (() => void) | null = null;
  #composing = false;
  #lineSource = "";
  #lineCount = 1;
  #restoredViewState = false;

  constructor(private readonly session: FileEditorSession) {
    this.element.className = "file-editor-panel";
    this.element.innerHTML = `
      <div class="file-editor-toolbar">
        <button type="button" data-editor-action="save">Save</button>
        <span class="file-editor-status"></span>
        <button type="button" data-editor-action="find">Find</button>
        <button type="button" data-editor-action="replace">Replace</button>
        <form class="file-editor-goto-form" hidden>
          <input class="file-editor-goto-input" type="number" min="1" aria-label="Line number" placeholder="Line" />
        </form>
        <button type="button" data-editor-action="goto">Go to Line</button>
        <button type="button" data-editor-action="wrap" aria-pressed="false">Wrap</button>
      </div>
      <div class="file-editor-banner" hidden></div>
      <div class="file-editor-search" hidden>
        <input class="file-editor-search-input" type="search" aria-label="Find" placeholder="Find" />
        <input class="file-editor-replace-input" type="text" aria-label="Replace" placeholder="Replace" />
        <span class="file-editor-search-result"></span>
        <button type="button" data-search-action="previous" aria-label="Previous match">↑</button>
        <button type="button" data-search-action="next" aria-label="Next match">↓</button>
        <button type="button" data-search-action="replace">Replace</button>
        <button type="button" data-search-action="replace-all">All</button>
        <button type="button" data-search-action="close" aria-label="Close find and replace">×</button>
      </div>
      <div class="file-editor-body">
        <div class="file-editor-line-viewport" aria-hidden="true"><pre class="file-editor-line-numbers"></pre></div>
        <div class="file-editor-code-layer">
          <div class="file-editor-current-line" aria-hidden="true"></div>
          <pre class="file-editor-highlight" aria-hidden="true"></pre>
          <textarea class="file-editor-input" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
          <div class="file-editor-empty-state" role="status">Loading…</div>
        </div>
      </div>
      <footer class="file-editor-footer">
        <span class="file-editor-position">Ln 1, Col 1</span>
        <span class="file-editor-format"></span>
      </footer>
    `;
    this.#textarea = required(this.element, ".file-editor-input");
    this.#highlight = required(this.element, ".file-editor-highlight");
    this.#lineNumbers = required(this.element, ".file-editor-line-numbers");
    this.#currentLine = required(this.element, ".file-editor-current-line");
    this.#banner = required(this.element, ".file-editor-banner");
    this.#empty = required(this.element, ".file-editor-empty-state");
    this.#position = required(this.element, ".file-editor-position");
    this.#format = required(this.element, ".file-editor-format");
    this.#status = required(this.element, ".file-editor-status");
    this.#searchPanel = required(this.element, ".file-editor-search");
    this.#searchInput = required(this.element, ".file-editor-search-input");
    this.#replaceInput = required(this.element, ".file-editor-replace-input");
    this.#searchResult = required(this.element, ".file-editor-search-result");
    this.#gotoForm = required(this.element, ".file-editor-goto-form");
    this.#gotoInput = required(this.element, ".file-editor-goto-input");
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.session.attach();
    this.#unsubscribe = this.session.subscribe(() => this.#render());
    this.#textarea.addEventListener("input", () => {
      this.session.setContent(this.#textarea.value, !this.#composing);
      this.#renderCode();
      this.#renderCursor();
    });
    this.#textarea.addEventListener("compositionstart", () => {
      this.#composing = true;
    });
    this.#textarea.addEventListener("compositionend", () => {
      this.#composing = false;
      this.session.setContent(this.#textarea.value, false);
      this.session.recordHistory();
    });
    this.#textarea.addEventListener("keydown", (event) =>
      this.#onKeyDown(event),
    );
    this.#textarea.addEventListener("scroll", () => this.#syncScroll());
    for (const event of ["click", "keyup", "select"] as const)
      this.#textarea.addEventListener(event, () => this.#selectionChanged());
    this.element
      .querySelector(".file-editor-toolbar")
      ?.addEventListener("click", (event) => {
        const action = (
          event.target as Element | null
        )?.closest<HTMLButtonElement>("button[data-editor-action]")?.dataset
          .editorAction;
        if (action) this.#runToolbarAction(action);
      });
    this.#searchPanel.addEventListener("click", (event) => {
      const action = (
        event.target as Element | null
      )?.closest<HTMLButtonElement>("button[data-search-action]")?.dataset
        .searchAction;
      if (action) this.#runSearchAction(action);
    });
    this.#searchInput.addEventListener("input", () =>
      this.#updateSearchCount(),
    );
    this.#searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.#find(!event.shiftKey);
      } else if (event.key === "Escape") this.#closeSearch();
    });
    this.#gotoForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#goToLine(Number(this.#gotoInput.value));
    });
    requestAnimationFrame(() => {
      if (parameters.api.group.activePanel?.id === parameters.api.id)
        this.focus();
    });
  }

  layout(): void {
    this.#syncScroll();
  }

  focus(): void {
    if (
      !this.#searchPanel.hidden &&
      document.activeElement === this.#searchInput
    )
      return;
    this.#textarea.focus();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.session.detach();
  }

  #render(): void {
    const snapshot = this.session.snapshot();
    this.element.dataset.state = snapshot.status;
    if (this.#textarea.value !== snapshot.content) {
      const anchor = Math.min(
        this.#textarea.selectionStart,
        snapshot.content.length,
      );
      const head = Math.min(
        this.#textarea.selectionEnd,
        snapshot.content.length,
      );
      this.#textarea.value = snapshot.content;
      this.#textarea.setSelectionRange(anchor, head);
    }
    this.#textarea.readOnly = !snapshot.canEdit;
    this.#textarea.wrap = snapshot.state.wordWrap ? "soft" : "off";
    this.#textarea.setAttribute("aria-label", `Edit ${snapshot.relativePath}`);
    this.element.dataset.wordWrap = String(snapshot.state.wordWrap);
    this.element.dataset.plainText = String(
      !snapshot.syntaxHighlighting && snapshot.content.length > 0,
    );
    const save = this.element.querySelector<HTMLButtonElement>(
      "[data-editor-action='save']",
    );
    if (save) save.disabled = !snapshot.canSave;
    const wrap = this.element.querySelector<HTMLButtonElement>(
      "[data-editor-action='wrap']",
    );
    wrap?.setAttribute("aria-pressed", String(snapshot.state.wordWrap));
    this.#status.textContent = snapshot.notice ?? statusLabel(snapshot.status);
    this.#format.textContent = `${languageForPath(snapshot.relativePath)} · ${
      snapshot.utf8Bom ? "UTF-8 BOM" : "UTF-8"
    } · ${snapshot.lineEnding === "crlf" ? "CRLF" : "LF"}`;
    this.#banner.hidden = !snapshot.message;
    this.#banner.textContent = snapshot.message ?? "";
    this.#empty.hidden =
      snapshot.status !== "loading" &&
      !(snapshot.status === "error" && snapshot.content.length === 0) &&
      !(snapshot.status === "read-only" && snapshot.content.length === 0);
    this.#empty.textContent =
      snapshot.status === "loading"
        ? "Loading…"
        : (snapshot.message ?? "This file cannot be edited.");
    this.#renderCursor();
    if (!this.#restoredViewState && snapshot.status !== "loading") {
      const anchor = Math.min(
        snapshot.state.selectionAnchor,
        snapshot.content.length,
      );
      const head = Math.min(
        snapshot.state.selectionHead,
        snapshot.content.length,
      );
      this.#textarea.setSelectionRange(anchor, head);
      this.#textarea.scrollTop = snapshot.state.scrollTop;
      this.#syncScroll();
      this.#restoredViewState = true;
    }
  }

  #renderCode(): void {
    const snapshot = this.session.snapshot();
    if (snapshot.content !== this.#lineSource) {
      this.#lineSource = snapshot.content;
      this.#lineCount = countLines(snapshot.content);
    }
    if (snapshot.syntaxHighlighting) {
      const brackets = findBracketMatch(
        snapshot.content,
        this.#textarea.selectionStart,
      );
      this.#highlight.innerHTML = highlightSource(
        snapshot.content,
        languageForPath(snapshot.relativePath),
        brackets,
      );
    } else {
      this.#highlight.replaceChildren();
    }
    this.#renderLineNumbers(snapshot.syntaxHighlighting);
    this.#syncScroll();
  }

  #renderLineNumbers(full: boolean): void {
    if (full) {
      this.#lineNumbers.textContent = Array.from(
        { length: this.#lineCount },
        (_, index) => index + 1,
      ).join("\n");
      this.#lineNumbers.dataset.virtualStart = "0";
      return;
    }
    const start = Math.max(0, Math.floor(this.#textarea.scrollTop / 20) - 1);
    const visible = Math.ceil(this.#textarea.clientHeight / 20) + 3;
    const end = Math.min(this.#lineCount, start + visible);
    this.#lineNumbers.textContent = Array.from(
      { length: end - start },
      (_, index) => start + index + 1,
    ).join("\n");
    this.#lineNumbers.dataset.virtualStart = String(start);
  }

  #renderCursor(): void {
    const snapshot = this.session.snapshot();
    const position = lineAndColumn(
      snapshot.content,
      this.#textarea.selectionStart,
    );
    this.#position.textContent = `Ln ${position.line}, Col ${position.column}`;
    this.#currentLine.style.transform = `translateY(${
      (position.line - 1) * 20 - this.#textarea.scrollTop
    }px)`;
    this.#renderCode();
  }

  #syncScroll(): void {
    const x = this.#textarea.scrollLeft;
    const y = this.#textarea.scrollTop;
    this.#highlight.style.transform = `translate(${-x}px, ${-y}px)`;
    if (this.element.dataset.plainText === "true")
      this.#renderLineNumbers(false);
    const virtualStart = Number(this.#lineNumbers.dataset.virtualStart ?? 0);
    this.#lineNumbers.style.transform = `translateY(${virtualStart * 20 - y}px)`;
    const position = lineAndColumn(
      this.#textarea.value,
      this.#textarea.selectionStart,
    );
    this.#currentLine.style.transform = `translateY(${(position.line - 1) * 20 - y}px)`;
    this.session.updateViewState({ scrollTop: y });
  }

  #selectionChanged(): void {
    this.session.updateViewState({
      selectionAnchor: this.#textarea.selectionStart,
      selectionHead: this.#textarea.selectionEnd,
    });
    this.#renderCursor();
  }

  #onKeyDown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "s") {
      event.preventDefault();
      void this.session.save();
    } else if (mod && key === "f" && !(event.metaKey && event.altKey)) {
      event.preventDefault();
      this.#openSearch(false);
    } else if (
      (event.ctrlKey && key === "h") ||
      (event.metaKey && event.altKey && key === "f")
    ) {
      event.preventDefault();
      this.#openSearch(true);
    } else if (mod && key === "g") {
      event.preventDefault();
      this.#openGoTo();
    } else if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this.session.redo();
      else this.session.undo();
    } else if (event.key === "Enter" && !this.#textarea.readOnly) {
      event.preventDefault();
      const start = this.#textarea.selectionStart;
      const before = this.#textarea.value.slice(0, start);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const extra = /[{[(]\s*$/.test(line) ? "  " : "";
      this.#insertText(`\n${indent}${extra}`);
    } else if (event.key === "Tab" && !this.#textarea.readOnly) {
      event.preventDefault();
      this.#insertText("  ");
    }
  }

  #insertText(value: string): void {
    this.#textarea.setRangeText(
      value,
      this.#textarea.selectionStart,
      this.#textarea.selectionEnd,
      "end",
    );
    this.session.setContent(this.#textarea.value, true);
    this.#selectionChanged();
  }

  #runToolbarAction(action: string): void {
    if (action === "save") void this.session.save();
    else if (action === "find") this.#openSearch(false);
    else if (action === "replace") this.#openSearch(true);
    else if (action === "goto") this.#openGoTo();
    else if (action === "wrap") {
      const wrap = !this.session.snapshot().state.wordWrap;
      this.session.updateViewState({ wordWrap: wrap });
      this.#render();
    }
  }

  #openSearch(replace: boolean): void {
    this.#searchPanel.hidden = false;
    this.#searchPanel.dataset.replace = String(replace);
    const selected = this.#textarea.value.slice(
      this.#textarea.selectionStart,
      this.#textarea.selectionEnd,
    );
    if (selected && !selected.includes("\n"))
      this.#searchInput.value = selected;
    (replace ? this.#replaceInput : this.#searchInput).focus();
    this.#updateSearchCount();
  }

  #closeSearch(): void {
    this.#searchPanel.hidden = true;
    this.#textarea.focus();
  }

  #runSearchAction(action: string): void {
    if (action === "close") this.#closeSearch();
    else if (action === "next") this.#find(true);
    else if (action === "previous") this.#find(false);
    else if (action === "replace") this.#replaceCurrent();
    else if (action === "replace-all") this.#replaceAll();
  }

  #matches(): Array<{ from: number; to: number }> {
    const query = this.#searchInput.value;
    if (!query) return [];
    const source = this.#textarea.value.toLocaleLowerCase();
    const target = query.toLocaleLowerCase();
    const matches: Array<{ from: number; to: number }> = [];
    let position = 0;
    while ((position = source.indexOf(target, position)) >= 0) {
      matches.push({ from: position, to: position + query.length });
      position += Math.max(1, query.length);
    }
    return matches;
  }

  #updateSearchCount(): void {
    const matches = this.#matches();
    this.#searchResult.textContent = this.#searchInput.value
      ? `${matches.length} result${matches.length === 1 ? "" : "s"}`
      : "";
  }

  #find(next: boolean): void {
    const matches = this.#matches();
    if (matches.length === 0) {
      this.#searchResult.textContent = this.#searchInput.value
        ? "No results"
        : "";
      return;
    }
    const edge = next
      ? this.#textarea.selectionEnd
      : this.#textarea.selectionStart;
    const match = next
      ? (matches.find((candidate) => candidate.from >= edge) ?? matches[0])
      : ([...matches].reverse().find((candidate) => candidate.to <= edge) ??
        matches.at(-1));
    if (!match) return;
    this.#textarea.focus();
    this.#textarea.setSelectionRange(match.from, match.to);
    const index = matches.indexOf(match);
    this.#searchResult.textContent = `${index + 1}/${matches.length}`;
    this.#selectionChanged();
  }

  #replaceCurrent(): void {
    const query = this.#searchInput.value;
    const selected = this.#textarea.value.slice(
      this.#textarea.selectionStart,
      this.#textarea.selectionEnd,
    );
    if (selected.toLocaleLowerCase() !== query.toLocaleLowerCase()) {
      this.#find(true);
      return;
    }
    this.#textarea.setRangeText(
      this.#replaceInput.value,
      this.#textarea.selectionStart,
      this.#textarea.selectionEnd,
      "end",
    );
    this.session.setContent(this.#textarea.value, true);
    this.#find(true);
  }

  #replaceAll(): void {
    const query = this.#searchInput.value;
    if (!query) return;
    const pattern = new RegExp(escapeRegExp(query), "gi");
    const replaced = this.#textarea.value.replace(
      pattern,
      this.#replaceInput.value,
    );
    if (replaced === this.#textarea.value) return;
    this.#textarea.value = replaced;
    this.session.setContent(replaced, true);
    this.#searchResult.textContent = "Replaced all";
  }

  #openGoTo(): void {
    this.#gotoForm.hidden = false;
    this.#gotoInput.value = "";
    this.#gotoInput.focus();
  }

  #goToLine(line: number): void {
    if (!Number.isFinite(line) || line < 1) return;
    const lines = this.#textarea.value.split("\n");
    const target = Math.min(Math.floor(line), lines.length);
    let position = 0;
    for (let index = 1; index < target; index += 1)
      position += (lines[index - 1]?.length ?? 0) + 1;
    this.#textarea.focus();
    this.#textarea.setSelectionRange(position, position);
    this.#gotoForm.hidden = true;
    this.#selectionChanged();
  }
}

function statusLabel(status: EditorStatus): string {
  switch (status) {
    case "loading":
      return "Loading";
    case "clean":
      return "Ready";
    case "dirty":
      return "Unsaved";
    case "saving":
      return "Saving…";
    case "conflict":
      return "Conflict";
    case "read-only":
      return "Read-only";
    case "error":
      return "Error";
  }
}

function isConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "conflict",
  );
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "not_found",
  );
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing File Editor element: ${selector}`);
  return element;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLines(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index += 1)
    if (value.charCodeAt(index) === 10) count += 1;
  return count;
}
