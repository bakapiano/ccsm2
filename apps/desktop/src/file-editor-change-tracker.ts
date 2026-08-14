import { ChangeSet } from "@codemirror/state";

export interface FileEditorSaveSnapshot {
  content: string;
  version: number;
}

export class FileEditorChangeTracker {
  #changes: ChangeSet;
  #readCurrent: (() => string) | null = null;
  #version = 0;

  constructor(documentLength = 0) {
    this.#changes = ChangeSet.empty(documentLength);
  }

  get dirty(): boolean {
    return !this.#changes.empty;
  }

  apply(changes: ChangeSet, readCurrent: () => string): void {
    this.#changes = this.#changes.compose(changes);
    this.#readCurrent = readCurrent;
    this.#version += 1;
  }

  reset(documentLength: number): void {
    this.#changes = ChangeSet.empty(documentLength);
    this.#readCurrent = null;
    this.#version += 1;
  }

  snapshotForSave(fallback: string): FileEditorSaveSnapshot {
    return {
      content: this.#readCurrent?.() ?? fallback,
      version: this.#version,
    };
  }

  markSaved(savedContent: string, savedVersion: number): void {
    if (savedVersion === this.#version) {
      this.reset(savedContent.length);
      return;
    }
    const current = this.#readCurrent?.() ?? savedContent;
    this.#changes =
      current === savedContent
        ? ChangeSet.empty(savedContent.length)
        : ChangeSet.of(
            { from: 0, to: savedContent.length, insert: current },
            savedContent.length,
          );
  }
}
