import { describe, expect, test } from "bun:test";

const provider = await Bun.file(
  new URL("./tabs/file-editor-provider.ts", import.meta.url),
).text();
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const vditorEditor = await Bun.file(
  new URL("./vditor-editor.ts", import.meta.url),
).text();

describe("File Editor engine", () => {
  test("pins CodeMirror 6 for text files", () => {
    expect(packageJson.dependencies.codemirror).toBe("6.0.2");
    expect(packageJson.dependencies["@codemirror/view"]).toBe("6.43.8");
    expect(provider).toContain("new EditorView");
    expect(provider).toContain("editorEngineForPath(session.relativePath)");
    expect(provider).toContain("readonly #panels");
    expect(provider).toContain("this.#panels.get(tab.id)");
    expect(
      provider.match(/dataset\.documentLength = String/g)?.length,
    ).toBeGreaterThan(3);
  });

  test("loads Vditor IR with the full Markdown renderers", () => {
    expect(packageJson.dependencies.vditor).toBe("3.11.2");
    expect(provider).toContain('import("../vditor-editor")');
    expect(vditorEditor).toContain('mode: "ir"');
    expect(vditorEditor).toContain('engine: "KaTeX"');
    expect(vditorEditor).toContain("style: codeTheme(options.theme)");
    expect(vditorEditor).toContain("sanitize: true");
  });

  test("does not retain the handwritten textarea editor", () => {
    expect(provider).not.toContain("<textarea");
    expect(provider).not.toContain("highlightSource");
    expect(provider).not.toContain("#replaceAll");
    expect(provider).not.toContain("recordHistory");
  });
});
