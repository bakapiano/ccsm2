import { indentWithTab, redo } from "@codemirror/commands";
import {
  indentUnit,
  LanguageDescription,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Prec,
  type ChangeSet,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import {
  showFileEditorDialog,
  type FileEditorDialogOptions,
} from "../file-editor-dialog";
import { codeHighlightStyle } from "../code-highlighting";
import { FileEditorChangeTracker } from "../file-editor-change-tracker";
import {
  editorEngineForPath,
  fileChangeAffectsPath,
  fileName,
  languageForPath,
  parseFileEditorState,
  type FileEditorTabState,
  type MarkdownMode,
} from "../file-editor-model";
import type { FileDocumentDto } from "../generated/FileDocumentDto";
import type { FileLineEnding } from "../generated/FileLineEnding";
import type { TabDto } from "../generated/TabDto";
import { renderMarkdownPreview } from "../markdown-preview";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import { uiIcon } from "../ui-icons";
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
  documentGeneration: number;
}

export class FileEditorTabProvider implements TabProvider {
  readonly kind = "file-editor" as const;
  readonly #sessions = new Map<string, FileEditorSession>();
  readonly #panels = new Map<string, FileEditorPanel>();
  readonly #pendingReveals = new Map<string, EditorRevealPosition>();

  constructor(
    private readonly client: CcsmDesktopClient,
    private readonly options: FileEditorProviderOptions,
  ) {}

  createRenderer(tab: TabDto): IContentRenderer {
    let panel = this.#panels.get(tab.id);
    if (!panel) {
      panel = new FileEditorPanel(this.#session(tab));
      this.#panels.set(tab.id, panel);
      const pending = this.#pendingReveals.get(tab.id);
      if (pending) {
        this.#pendingReveals.delete(tab.id);
        panel.revealPosition(pending);
      }
    }
    return panel;
  }

  revealPosition(tabId: string, position: EditorRevealPosition): void {
    const normalized = {
      line: Math.max(1, Math.floor(position.line)),
      column: Math.max(1, Math.floor(position.column)),
    };
    const panel = this.#panels.get(tabId);
    if (panel) panel.revealPosition(normalized);
    else this.#pendingReveals.set(tabId, normalized);
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
    return this.#requestCloseSessions(sessions);
  }

  async requestCloseAll(): Promise<boolean> {
    return this.#requestCloseSessions(
      [...this.#sessions.values()].filter((session) => session.isDirty()),
    );
  }

  releaseTab(tabId: string): void {
    this.#panels.get(tabId)?.destroy();
    this.#panels.delete(tabId);
    this.#sessions.get(tabId)?.dispose();
    this.#sessions.delete(tabId);
    this.#pendingReveals.delete(tabId);
    this.options.presentationChanged();
  }

  destroyAll(): void {
    for (const panel of this.#panels.values()) panel.destroy();
    this.#panels.clear();
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
    this.#pendingReveals.clear();
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

  async #requestCloseSessions(
    sessions: readonly FileEditorSession[],
  ): Promise<boolean> {
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

export class FileEditorSession {
  readonly relativePath: string;
  readonly #viewState: FileEditorTabState;
  readonly #listeners = new Set<() => void>();
  #status: EditorStatus = "loading";
  #diskContent = "";
  readonly #changes = new FileEditorChangeTracker();
  #revision: string | null = null;
  #utf8Bom = false;
  #lineEnding: FileLineEnding = "lf";
  #syntaxHighlighting = false;
  #message: string | null = null;
  #notice: string | null = null;
  #deleted = false;
  #documentGeneration = 0;
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
      const revalidateAfterSubscribe = this.#status !== "loading";
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
          else {
            this.#unlisten = unlisten;
            if (revalidateAfterSubscribe) void this.#handleExternalChange();
          }
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
      content: this.#diskContent,
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
      documentGeneration: this.#documentGeneration,
    };
  }

  isDirty(): boolean {
    return this.#changes.dirty;
  }

  applyEditorChanges(changes: ChangeSet, readCurrent: () => string): void {
    const wasDirty = this.isDirty();
    this.#changes.apply(changes, readCurrent);
    if (this.#status !== "conflict" && this.#status !== "read-only") {
      this.#status = this.isDirty() ? "dirty" : "clean";
      this.#message = null;
    }
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
    ) {
      return;
    }
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
    this.#diskContent = content;
    this.#changes.reset(content.length);
    this.#documentGeneration += 1;
    this.#status = document.status === "editable" ? "clean" : "read-only";
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
        this.#changes.reset(this.#diskContent.length);
        this.#documentGeneration += 1;
        this.#emit(wasDirty);
      }
      await this.#load(true, true);
      return;
    }
    await this.#performSave(true, this.#deleted);
  }

  async #performSave(overwrite: boolean, recreate: boolean): Promise<void> {
    const wasDirty = this.isDirty();
    const changeSnapshot = this.#changes.snapshotForSave(this.#diskContent);
    const savedContent = changeSnapshot.content;
    const saveVersion = changeSnapshot.version;
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
      this.#changes.markSaved(savedContent, saveVersion);
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

const codeMirrorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ink)",
    backgroundColor: "var(--bg-elev)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--file-editor-mono)",
    fontSize: "12px",
    lineHeight: "20px",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "8px 0 20px",
    caretColor: "var(--ink)",
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-gutters": {
    borderRight: "1px solid var(--border-soft)",
    color: "var(--ink-faint)",
    backgroundColor: "var(--bg)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "42px",
    padding: "0 9px 0 4px",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--accent-softer)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  ".cm-matchingBracket": {
    borderRadius: "2px",
    backgroundColor: "color-mix(in srgb, var(--yellow) 28%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--yellow) 58%, transparent)",
  },
  ".cm-panels": {
    color: "var(--ink)",
    backgroundColor: "var(--bg-elev)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-search": {
    display: "grid",
    gridTemplateColumns:
      "minmax(132px, 1fr) auto auto auto auto auto auto 20px",
    alignItems: "center",
    gap: "5px",
    padding: "5px 7px",
  },
  ".cm-panel.cm-search > input, .cm-panel.cm-search > button, .cm-panel.cm-search > label":
    {
      margin: "0",
    },
  ".cm-search > br": { display: "none" },
  ".cm-search > .cm-textfield": {
    width: "100%",
    minWidth: "0",
    height: "var(--control-height)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--control-radius)",
    padding: "0 7px",
    color: "var(--ink)",
    backgroundColor: "var(--bg-elev)",
    fontFamily: "var(--mono)",
    fontSize: "11px",
  },
  ".cm-search > input[name=search]": { gridColumn: "1", gridRow: "1" },
  ".cm-search > button[name=next]": { gridColumn: "2", gridRow: "1" },
  ".cm-search > button[name=prev]": { gridColumn: "3", gridRow: "1" },
  ".cm-search > button[name=select]": { gridColumn: "4", gridRow: "1" },
  ".cm-search > label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "var(--control-height)",
    margin: "0",
    justifySelf: "start",
    color: "var(--ink-mid)",
    fontSize: "10px",
    lineHeight: "1",
    whiteSpace: "nowrap",
    userSelect: "none",
    cursor: "pointer",
  },
  ".cm-search > label:has(input[name=case])": {
    gridColumn: "5",
    gridRow: "1",
  },
  ".cm-search > label:has(input[name=re])": {
    gridColumn: "6",
    gridRow: "1",
  },
  ".cm-search > label:has(input[name=word])": {
    gridColumn: "7",
    gridRow: "1",
  },
  ".cm-panel.cm-search > label > input[type=checkbox]": {
    width: "13px",
    height: "13px",
    margin: "0",
    flex: "0 0 13px",
    accentColor: "var(--accent)",
  },
  ".cm-search > input[name=replace]": { gridColumn: "1", gridRow: "2" },
  ".cm-search > button[name=replace]": { gridColumn: "2", gridRow: "2" },
  ".cm-search > button[name=replaceAll]": {
    gridColumn: "3 / span 2",
    gridRow: "2",
  },
  ".cm-search button, .cm-button": {
    height: "var(--control-height)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--control-radius)",
    padding: "0 9px",
    color: "var(--ink-mid)",
    backgroundImage: "none",
    backgroundColor: "var(--bg-elev)",
    fontSize: "11px",
  },
  ".cm-search button:hover, .cm-button:hover": {
    color: "var(--ink)",
    backgroundColor: "var(--control-hover)",
  },
  ".cm-search > button[name=close]": {
    position: "static",
    gridColumn: "8",
    gridRow: "1",
    alignSelf: "center",
    width: "20px",
    height: "20px",
    padding: "0",
    border: "0",
    color: "var(--ink-muted)",
    backgroundColor: "transparent",
    boxShadow: "none",
    fontSize: "15px",
  },
  ".cm-search > button[name=close]:hover": {
    color: "var(--ink)",
    backgroundColor: "var(--control-hover)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border-strong)",
    color: "var(--ink)",
    backgroundColor: "var(--bg-elev)",
    boxShadow: "var(--shadow-md)",
  },
});

class FileEditorPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #host: HTMLElement;
  readonly #markdownHost: HTMLElement;
  readonly #banner: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #position: HTMLElement;
  readonly #format: HTMLElement;
  readonly #status: HTMLElement;
  readonly #languageCompartment = new Compartment();
  readonly #wrapCompartment = new Compartment();
  readonly #editableCompartment = new Compartment();
  readonly #engine;
  #markdownMode: MarkdownMode;
  #view: EditorView | null = null;
  #unsubscribe: (() => void) | null = null;
  #attached = false;
  #destroyed = false;
  #synchronizing = false;
  #documentGeneration = -1;
  #restorePersistedViewState = true;
  #wordWrap = false;
  #canEdit = false;
  #languageKey = "";
  #languageLabel = "text";
  #languageSupport: Extension = [];
  #languageRequest = 0;
  #pendingReveal: EditorRevealPosition | null = null;
  #previewDocument: string | null = null;

  constructor(private readonly session: FileEditorSession) {
    this.#engine = editorEngineForPath(session.relativePath);
    this.#markdownMode =
      this.#engine === "markdown"
        ? session.snapshot().state.markdownMode
        : "edit";
    this.element.className = "file-editor-panel";
    this.element.dataset.editorEngine = this.#engine;
    this.element.dataset.markdownMode = this.#markdownMode;
    (this.element as FileEditorDebugElement).__CCSM_FILE_EDITOR_DEBUG__ =
      () => ({
        documentLength: this.#view?.state.doc.length ?? 0,
        insertText: (text: string) => {
          const view = this.#view;
          if (!view) return false;
          view.dispatch({
            changes: { from: view.state.doc.length, insert: text },
          });
          return true;
        },
      });
    this.element.innerHTML = `
      <div class="file-editor-toolbar panel-toolbar">
        <button class="file-editor-save control-button" type="button" data-editor-action="save" title="Save (Ctrl+S)" aria-keyshortcuts="Control+S Meta+S">
          <span class="control-icon">${uiIcon("save")}</span>
          <span class="file-editor-save-label">Save</span>
        </button>
        <div class="file-editor-markdown-modes" role="group" aria-label="Markdown mode">
          <button class="control-button" type="button" data-editor-action="markdown-edit" aria-pressed="false">Edit</button>
          <button class="control-button" type="button" data-editor-action="markdown-preview" aria-pressed="false">Preview</button>
        </div>
        <div class="file-editor-actions" role="toolbar" aria-label="Editor commands">
          <button class="control-button control-button-icon" type="button" data-editor-action="find" data-codemirror-action aria-label="Find" title="Find (Ctrl+F)">${uiIcon("find")}</button>
          <button class="control-button control-button-icon file-editor-secondary-action" type="button" data-editor-action="replace" data-codemirror-action aria-label="Replace" title="Replace (Ctrl+H)">${uiIcon("replace")}</button>
          <button class="control-button control-button-icon file-editor-secondary-action" type="button" data-editor-action="goto" data-codemirror-action aria-label="Go to line" title="Go to line (Ctrl+G)">${uiIcon("goto-line")}</button>
          <button class="control-button control-button-icon" type="button" data-editor-action="wrap" data-codemirror-action aria-label="Toggle word wrap" title="Toggle word wrap" aria-pressed="false">${uiIcon("wrap")}</button>
          <details class="file-editor-overflow" data-codemirror-action>
            <summary aria-label="More editor commands" title="More editor commands">${uiIcon("ellipsis")}</summary>
            <div class="file-editor-overflow-menu" role="menu">
              <button type="button" role="menuitem" data-editor-action="replace">${uiIcon("replace")}<span>Replace</span></button>
              <button type="button" role="menuitem" data-editor-action="goto">${uiIcon("goto-line")}<span>Go to Line</span></button>
            </div>
          </details>
        </div>
      </div>
      <div class="file-editor-banner" hidden></div>
      <div class="file-editor-body">
        <div class="file-editor-codemirror"></div>
        <div class="file-editor-markdown-preview" role="document" tabindex="0"></div>
        <div class="file-editor-empty-state" role="status">Loading…</div>
      </div>
      <footer class="file-editor-footer">
        <span class="file-editor-status panel-status"></span>
        <span class="file-editor-footer-spacer"></span>
        <span class="file-editor-position">Ln 1, Col 1</span>
        <span class="file-editor-format"></span>
      </footer>
    `;
    this.#host = required(this.element, ".file-editor-codemirror");
    this.#markdownHost = required(
      this.element,
      ".file-editor-markdown-preview",
    );
    this.#markdownHost.setAttribute(
      "aria-label",
      `Preview ${session.relativePath}`,
    );
    this.#markdownHost.addEventListener("keydown", this.#onMarkdownKeyDown);
    this.#markdownHost.addEventListener("scroll", this.#onMarkdownScroll, {
      passive: true,
    });
    this.#banner = required(this.element, ".file-editor-banner");
    this.#empty = required(this.element, ".file-editor-empty-state");
    this.#position = required(this.element, ".file-editor-position");
    this.#format = required(this.element, ".file-editor-format");
    this.#status = required(this.element, ".file-editor-status");
    this.element
      .querySelector(".file-editor-toolbar")
      ?.addEventListener("click", (event) => {
        const action = (
          event.target as Element | null
        )?.closest<HTMLButtonElement>("button[data-editor-action]")?.dataset
          .editorAction;
        if (action) {
          this.#runToolbarAction(action);
          const details = (event.target as Element | null)?.closest(
            ".file-editor-overflow",
          ) as HTMLDetailsElement | null;
          if (details) details.open = false;
        }
      });
  }

  init(parameters: GroupPanelPartInitParameters): void {
    if (this.#destroyed || this.#attached) return;
    this.#attached = true;
    this.session.attach();
    if (!this.#view) this.#createView(this.session.snapshot());
    this.#unsubscribe = this.session.subscribe(() => this.#render());
    requestAnimationFrame(() => {
      if (parameters.api.group.activePanel?.id === parameters.api.id) {
        this.focus();
      }
    });
  }

  layout(): void {
    this.#view?.requestMeasure();
  }

  focus(): void {
    if (this.#engine === "markdown" && this.#markdownMode === "preview") {
      this.#markdownHost.focus();
      return;
    }
    const view = this.#view;
    if (!view || view.dom.contains(document.activeElement)) return;
    view.focus();
  }

  revealPosition(position: EditorRevealPosition): void {
    this.#pendingReveal = position;
    this.#applyPendingReveal();
  }

  dispose(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.session.detach();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#languageRequest += 1;
    this.dispose();
    this.#markdownHost.removeEventListener("keydown", this.#onMarkdownKeyDown);
    this.#markdownHost.removeEventListener("scroll", this.#onMarkdownScroll);
    this.#view?.destroy();
    this.#view = null;
    delete (this.element as FileEditorDebugElement).__CCSM_FILE_EDITOR_DEBUG__;
  }

  #createView(snapshot: SessionSnapshot): void {
    this.#updateLanguage(snapshot);
    this.#wordWrap = snapshot.state.wordWrap;
    this.#canEdit = snapshot.canEdit;
    this.#documentGeneration = snapshot.documentGeneration;
    this.#view = new EditorView({
      state: this.#createState(
        snapshot,
        snapshot.state.selectionAnchor,
        snapshot.state.selectionHead,
      ),
      parent: this.#host,
    });
    this.element.dataset.documentLength = String(this.#view.state.doc.length);
    this.#view.scrollDOM.addEventListener("scroll", this.#onScroll, {
      passive: true,
    });
    if (snapshot.status !== "loading") this.#restorePersistedViewState = false;
    requestAnimationFrame(() => {
      if (!this.#view || this.#destroyed) return;
      this.#view.scrollDOM.scrollTop = snapshot.state.scrollTop;
      this.#renderPosition();
    });
  }

  #renderMarkdownPreview(snapshot: SessionSnapshot): void {
    const view = this.#view;
    if (!view || snapshot.status === "loading") return;
    const source = view.state.doc.toString();
    if (source === this.#previewDocument) return;
    const scrollTop =
      this.#previewDocument === null
        ? snapshot.state.previewScrollTop
        : this.#markdownHost.scrollTop;
    this.#markdownHost.replaceChildren(renderMarkdownPreview(source));
    this.#previewDocument = source;
    requestAnimationFrame(() => {
      if (this.#destroyed) return;
      this.#markdownHost.scrollTop = scrollTop;
    });
  }

  #createState(
    snapshot: SessionSnapshot,
    selectionAnchor: number,
    selectionHead: number,
  ): EditorState {
    const length = snapshot.content.length;
    const anchor = Math.max(0, Math.min(selectionAnchor, length));
    const head = Math.max(0, Math.min(selectionHead, length));
    return EditorState.create({
      doc: snapshot.content,
      selection: { anchor, head },
      extensions: [
        basicSetup,
        indentUnit.of("  "),
        codeMirrorTheme,
        syntaxHighlighting(codeHighlightStyle),
        this.#languageCompartment.of(this.#languageSupport),
        this.#wrapCompartment.of(
          snapshot.state.wordWrap ? EditorView.lineWrapping : [],
        ),
        this.#editableCompartment.of(editableExtensions(snapshot.canEdit)),
        EditorView.contentAttributes.of({
          "aria-label": `Edit ${snapshot.relativePath}`,
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => this.#onUpdate(update)),
        Prec.highest(keymap.of(this.#keyBindings())),
      ],
    });
  }

  #keyBindings(): KeyBinding[] {
    return [
      {
        key: "Mod-s",
        run: () => {
          void this.session.save();
          return true;
        },
        preventDefault: true,
      },
      {
        key: "Ctrl-h",
        mac: "Cmd-Alt-f",
        run: () => this.#openReplace(),
        preventDefault: true,
      },
      { key: "Mod-g", run: gotoLine, preventDefault: true },
      { key: "Ctrl-Shift-z", run: redo, preventDefault: true },
      indentWithTab,
    ];
  }

  #onUpdate(update: ViewUpdate): void {
    if (this.#synchronizing) return;
    this.element.dataset.documentLength = String(update.state.doc.length);
    if (update.docChanged) {
      const view = update.view;
      this.session.applyEditorChanges(update.changes, () =>
        view.state.doc.toString(),
      );
    }
    if (update.docChanged || update.selectionSet) {
      const selection = update.state.selection.main;
      this.session.updateViewState({
        selectionAnchor: selection.anchor,
        selectionHead: selection.head,
      });
    }
    this.#renderPosition();
  }

  readonly #onScroll = (): void => {
    const view = this.#view;
    if (!view) return;
    this.session.updateViewState({ scrollTop: view.scrollDOM.scrollTop });
  };

  readonly #onMarkdownScroll = (): void => {
    if (this.#engine !== "markdown" || this.#markdownMode !== "preview") return;
    this.session.updateViewState({
      previewScrollTop: this.#markdownHost.scrollTop,
    });
  };

  readonly #onMarkdownKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key.toLowerCase() !== "s" ||
      (!event.ctrlKey && !event.metaKey) ||
      event.altKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    void this.session.save();
  };

  #render(): void {
    const snapshot = this.session.snapshot();
    const view = this.#view;
    this.#updateLanguage(snapshot);
    if (view) {
      const documentChanged =
        this.#documentGeneration !== snapshot.documentGeneration;
      if (documentChanged) {
        const current = view.state.selection.main;
        const restorePersisted =
          this.#restorePersistedViewState && snapshot.status !== "loading";
        const anchor = restorePersisted
          ? snapshot.state.selectionAnchor
          : current.anchor;
        const head = restorePersisted
          ? snapshot.state.selectionHead
          : current.head;
        const scrollTop = restorePersisted
          ? snapshot.state.scrollTop
          : view.scrollDOM.scrollTop;
        this.#synchronizing = true;
        try {
          view.setState(this.#createState(snapshot, anchor, head));
          this.element.dataset.documentLength = String(view.state.doc.length);
        } finally {
          this.#synchronizing = false;
        }
        this.#documentGeneration = snapshot.documentGeneration;
        if (restorePersisted) this.#restorePersistedViewState = false;
        this.#wordWrap = snapshot.state.wordWrap;
        this.#canEdit = snapshot.canEdit;
        requestAnimationFrame(() => {
          if (!this.#view || this.#destroyed) return;
          this.#view.scrollDOM.scrollTop = scrollTop;
          this.#renderPosition();
        });
      } else {
        const effects = [];
        if (this.#wordWrap !== snapshot.state.wordWrap) {
          this.#wordWrap = snapshot.state.wordWrap;
          effects.push(
            this.#wrapCompartment.reconfigure(
              snapshot.state.wordWrap ? EditorView.lineWrapping : [],
            ),
          );
        }
        if (this.#canEdit !== snapshot.canEdit) {
          this.#canEdit = snapshot.canEdit;
          effects.push(
            this.#editableCompartment.reconfigure(
              editableExtensions(snapshot.canEdit),
            ),
          );
        }
        if (effects.length > 0) view.dispatch({ effects });
      }
    }
    if (this.#engine === "markdown" && this.#markdownMode === "preview") {
      this.#renderMarkdownPreview(snapshot);
    }
    this.#renderChrome(snapshot);
    this.#renderPosition();
    this.#applyPendingReveal();
  }

  #applyPendingReveal(): void {
    if (
      this.#pendingReveal &&
      this.#engine === "markdown" &&
      this.#markdownMode === "preview"
    ) {
      this.#setMarkdownMode("edit");
      return;
    }
    const position = this.#pendingReveal;
    const view = this.#view;
    if (!position || !view || this.session.snapshot().status === "loading")
      return;
    const lineNumber = Math.min(position.line, view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const offset = Math.min(line.to, line.from + position.column - 1);
    this.#pendingReveal = null;
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    view.focus();
  }

  #renderChrome(snapshot: SessionSnapshot): void {
    this.element.dataset.state = snapshot.status;
    this.element.dataset.wordWrap = String(snapshot.state.wordWrap);
    const save = this.element.querySelector<HTMLButtonElement>(
      "[data-editor-action='save']",
    );
    if (save) save.disabled = !snapshot.canSave;
    const wrap = this.element.querySelector<HTMLButtonElement>(
      "[data-editor-action='wrap']",
    );
    wrap?.setAttribute("aria-pressed", String(snapshot.state.wordWrap));
    for (const mode of ["edit", "preview"] as const) {
      const button = this.element.querySelector<HTMLButtonElement>(
        `[data-editor-action='markdown-${mode}']`,
      );
      button?.setAttribute("aria-pressed", String(this.#markdownMode === mode));
      if (button) button.disabled = snapshot.status === "loading";
    }
    this.#status.textContent =
      snapshot.notice ??
      (this.#engine === "markdown" &&
      this.#markdownMode === "preview" &&
      snapshot.status === "clean"
        ? "Preview"
        : statusLabel(snapshot.status));
    const languageLabel =
      this.#engine === "markdown"
        ? `Markdown · ${this.#markdownMode === "preview" ? "Preview" : "Edit"}`
        : this.#languageLabel;
    this.#format.textContent = `${languageLabel} · ${
      snapshot.utf8Bom ? "UTF-8 BOM" : "UTF-8"
    } · ${snapshot.lineEnding === "crlf" ? "CRLF" : "LF"}`;
    this.#banner.hidden = !snapshot.message;
    this.#banner.textContent = snapshot.message ?? "";
    this.#empty.hidden = !(
      snapshot.status === "loading" ||
      (snapshot.status === "error" && snapshot.content.length === 0) ||
      (snapshot.status === "read-only" && snapshot.content.length === 0)
    );
    this.#empty.textContent =
      snapshot.status === "loading"
        ? "Loading…"
        : (snapshot.message ?? "Preview unavailable.");
  }

  #renderPosition(): void {
    const view = this.#view;
    if (!view) return;
    if (this.#engine === "markdown" && this.#markdownMode === "preview") {
      this.#position.textContent = `${view.state.doc.length} chars`;
      return;
    }
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    this.#position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
  }

  #runToolbarAction(action: string): void {
    const view = this.#view;
    if (action === "save") void this.session.save();
    else if (action === "markdown-edit") this.#setMarkdownMode("edit");
    else if (action === "markdown-preview") this.#setMarkdownMode("preview");
    else if (action === "find" && view) openSearchPanel(view);
    else if (action === "replace") this.#openReplace();
    else if (action === "goto" && view) gotoLine(view);
    else if (action === "wrap") {
      const wordWrap = !this.session.snapshot().state.wordWrap;
      this.session.updateViewState({ wordWrap });
      this.#render();
    }
  }

  #setMarkdownMode(mode: MarkdownMode): void {
    if (this.#engine !== "markdown" || mode === this.#markdownMode) return;
    this.#markdownMode = mode;
    this.element.dataset.markdownMode = mode;
    this.session.updateViewState({ markdownMode: mode });
    this.#render();
    requestAnimationFrame(() => this.focus());
  }

  #openReplace(): boolean {
    const view = this.#view;
    if (!view) return false;
    openSearchPanel(view);
    requestAnimationFrame(() => {
      view.dom
        .querySelector<HTMLInputElement>(".cm-search input[name='replace']")
        ?.focus();
    });
    return true;
  }

  #updateLanguage(snapshot: SessionSnapshot): void {
    const key = snapshot.syntaxHighlighting
      ? snapshot.relativePath.toLowerCase()
      : "";
    if (key === this.#languageKey) return;
    this.#languageKey = key;
    const request = ++this.#languageRequest;
    const description = key
      ? LanguageDescription.matchFilename(languages, snapshot.relativePath)
      : null;
    this.#languageLabel =
      description?.name ?? languageForPath(snapshot.relativePath);
    this.#languageSupport = description?.support ?? [];
    this.#reconfigureLanguage();
    if (!description || description.support) return;
    void description
      .load()
      .then((support: LanguageSupport) => {
        if (this.#destroyed || request !== this.#languageRequest) return;
        this.#languageSupport = support;
        this.#reconfigureLanguage();
      })
      .catch(() => {
        // A failed optional language chunk leaves the document in plain text.
      });
  }

  #reconfigureLanguage(): void {
    const view = this.#view;
    if (!view) return;
    view.dispatch({
      effects: this.#languageCompartment.reconfigure(this.#languageSupport),
    });
  }
}

function editableExtensions(canEdit: boolean): Extension {
  return [EditorState.readOnly.of(!canEdit), EditorView.editable.of(canEdit)];
}

export interface EditorRevealPosition {
  line: number;
  column: number;
}

type FileEditorDebugElement = HTMLElement & {
  __CCSM_FILE_EDITOR_DEBUG__?: () => {
    documentLength: number;
    insertText(text: string): boolean;
  };
};

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
