import { describe, expect, test } from "bun:test";

const provider = await Bun.file(
  new URL("./tabs/file-editor-provider.ts", import.meta.url),
).text();
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();

describe("File Editor engine", () => {
  test("pins CodeMirror 6 as the editor implementation", () => {
    expect(packageJson.dependencies.codemirror).toBe("6.0.2");
    expect(packageJson.dependencies["@codemirror/view"]).toBe("6.43.8");
    expect(provider).toContain("new EditorView");
    expect(provider).toContain('dataset.editorEngine = "codemirror6"');
    expect(provider).toContain("readonly #panels");
    expect(provider).toContain("this.#panels.get(tab.id)");
    expect(provider.match(/dataset\.documentLength = String/g)).toHaveLength(3);
  });

  test("does not retain the handwritten textarea editor", () => {
    expect(provider).not.toContain("<textarea");
    expect(provider).not.toContain("highlightSource");
    expect(provider).not.toContain("#replaceAll");
    expect(provider).not.toContain("recordHistory");
  });
});
