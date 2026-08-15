import { ChangeSet } from "@codemirror/state";
import { describe, expect, test } from "bun:test";

import { FileEditorChangeTracker } from "./file-editor-change-tracker";

describe("File editor incremental change tracking", () => {
  test("tracks one thousand edits to a five MiB document without materializing it", () => {
    const initialLength = 5 * 1024 * 1024;
    const tracker = new FileEditorChangeTracker(initialLength);
    let length = initialLength;
    let materializations = 0;

    for (let index = 0; index < 1_000; index += 1) {
      const changes = ChangeSet.of({ from: length, insert: "x" }, length);
      length += 1;
      tracker.apply(changes, () => {
        materializations += 1;
        return "x".repeat(length);
      });
    }

    expect(tracker.dirty).toBe(true);
    expect(materializations).toBe(0);
    expect(tracker.snapshotForSave("").content.length).toBe(length);
    expect(materializations).toBe(1);
  });

  test("composed inverse edits return to the clean state", () => {
    const tracker = new FileEditorChangeTracker(3);
    tracker.apply(ChangeSet.of({ from: 1, insert: "x" }, 3), () => "axbc");
    tracker.apply(ChangeSet.of({ from: 1, to: 2 }, 4), () => "abc");

    expect(tracker.dirty).toBe(false);
  });
});
