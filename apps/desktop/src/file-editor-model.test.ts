import { describe, expect, test } from "bun:test";

import {
  distinctFileEditorTitles,
  fileChangeAffectsPath,
  findBracketMatch,
  languageForPath,
  lineAndColumn,
} from "./file-editor-model";

describe("file editor model", () => {
  test("uses the shortest parent suffix that disambiguates duplicate names", () => {
    const titles = distinctFileEditorTitles([
      { id: "a", path: "frontend/src/index.ts" },
      { id: "b", path: "backend/src/index.ts", dirty: true },
      { id: "c", path: "README.md" },
    ]);

    expect(titles.get("a")).toBe("index.ts — frontend/src");
    expect(titles.get("b")).toBe("index.ts — backend/src ●");
    expect(titles.get("c")).toBe("README.md");
  });

  test("maps common extensions and unknown files", () => {
    expect(languageForPath("src/main.rs")).toBe("rust");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("Dockerfile")).toBe("text");
  });

  test("matches filesystem hints and brackets", () => {
    expect(
      fileChangeAffectsPath(
        { rootId: "root", relativePaths: ["src\\main.rs"], overflow: false },
        "src/main.rs",
      ),
    ).toBe(true);
    expect(findBracketMatch("fn main() {}", 8)).toEqual([8, 7]);
  });

  test("reports one-based cursor coordinates", () => {
    expect(lineAndColumn("one\n中文", 6)).toEqual({ line: 2, column: 3 });
  });
});
