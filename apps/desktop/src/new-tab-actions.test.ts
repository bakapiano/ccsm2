import { describe, expect, test } from "bun:test";

import { NEW_TAB_ACTIONS } from "./new-tab-actions";

describe("New Tab menu", () => {
  test("contains every currently supported built-in Tab choice", () => {
    expect(NEW_TAB_ACTIONS.map((action) => action.id)).toEqual([
      "shell",
      "claude",
      "codex",
      "copilot",
      "browser",
      "files",
      "git",
    ]);
    expect(
      NEW_TAB_ACTIONS.filter((action) => action.type === "cli").map(
        (action) => action.provider,
      ),
    ).toEqual(["shell", "claude", "codex", "copilot"]);
    expect(
      NEW_TAB_ACTIONS.filter((action) => action.type === "tab").map(
        (action) => action.tabKind,
      ),
    ).toEqual(["browser", "file-explorer", "git"]);
  });
});
