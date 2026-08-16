import { describe, expect, test } from "bun:test";

import {
  distinctFileEditorTitles,
  editorEngineForPath,
  fileChangeAffectsPath,
  languageForPath,
  normalizeRelativePath,
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

  test("uses Vditor IR for Markdown documents", () => {
    expect(editorEngineForPath("README.md")).toBe("vditor-ir");
    expect(editorEngineForPath("docs/guide.markdown")).toBe("vditor-ir");
    expect(editorEngineForPath("component.mdx")).toBe("codemirror6");
    expect(editorEngineForPath("src/main.ts")).toBe("codemirror6");
  });

  test("normalizes paths and matches filesystem hints", () => {
    expect(normalizeRelativePath("/src\\nested//main.rs/")).toBe(
      "src/nested/main.rs",
    );
    expect(
      fileChangeAffectsPath(
        { rootId: "root", relativePaths: ["src\\main.rs"], overflow: false },
        "src/main.rs",
      ),
    ).toBe(true);
  });
});
