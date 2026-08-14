import { describe, expect, test } from "bun:test";

import type { FileEntryDto } from "./generated/FileEntryDto";
import {
  fileExplorerIconKind,
  fileTreeKeyboardAction,
  flattenFileTree,
} from "./file-explorer-tree";
import { fileResourceIconKind } from "./file-resource-icon";

function entry(relativePath: string, kind: FileEntryDto["kind"]): FileEntryDto {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    kind,
    size: kind === "file" ? 10 : null,
    modifiedAt: null,
  };
}

describe("VS Code-style File Explorer tree", () => {
  test("flattens only expanded directory branches", () => {
    const rows = flattenFileTree(
      "",
      new Map([
        ["", [entry("src", "directory"), entry("README.md", "file")]],
        ["src", [entry("src/main.ts", "file")]],
      ]),
      ["src"],
    );

    expect(rows.map((row) => [row.entry.relativePath, row.depth])).toEqual([
      ["src", 0],
      ["src/main.ts", 1],
      ["README.md", 0],
    ]);
  });

  test("uses resource-specific file and folder icons", () => {
    expect(fileExplorerIconKind(entry("src", "directory"), false)).toBe(
      "folder",
    );
    expect(fileExplorerIconKind(entry("src", "directory"), true)).toBe(
      "folder-open",
    );
    expect(fileExplorerIconKind(entry(".gitignore", "file"), false)).toBe(
      "config",
    );
    expect(fileExplorerIconKind(entry("src/main.ts", "file"), false)).toBe(
      "code",
    );
    expect(fileResourceIconKind("docs/README.md")).toBe("markdown");
    expect(fileResourceIconKind("nested/.gitignore")).toBe("config");
  });

  test("implements VS Code-style arrow and enter navigation", () => {
    const rows = flattenFileTree(
      "",
      new Map([
        ["", [entry("src", "directory"), entry("README.md", "file")]],
        ["src", [entry("src/main.ts", "file")]],
      ]),
      ["src"],
    );

    expect(fileTreeKeyboardAction(rows, "src", "ArrowRight")).toEqual({
      action: "focus",
      path: "src/main.ts",
    });
    expect(fileTreeKeyboardAction(rows, "src/main.ts", "ArrowLeft")).toEqual({
      action: "focus",
      path: "src",
    });
    expect(fileTreeKeyboardAction(rows, "README.md", "Enter")).toEqual({
      action: "open",
      path: "README.md",
    });
  });
});
