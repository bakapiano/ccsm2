import { describe, expect, test } from "bun:test";

const provider = await Bun.file(
  new URL("./tabs/file-editor-provider.ts", import.meta.url),
).text();
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const markdownPreview = await Bun.file(
  new URL("./markdown-preview.ts", import.meta.url),
).text();

describe("File Editor engine", () => {
  test("pins CodeMirror 6 for editable text", () => {
    expect(packageJson.dependencies.codemirror).toBe("6.0.2");
    expect(packageJson.dependencies["@codemirror/view"]).toBe("6.43.8");
    expect(provider).toContain("new EditorView");
    expect(provider).toContain("session.applyEditorChanges");
    expect(provider).toContain("editorEngineForPath(session.relativePath)");
    expect(provider).toContain("readonly #panels");
    expect(provider).toContain("this.#panels.get(tab.id)");
  });

  test("uses markdown-it for the Markdown preview mode", () => {
    expect(packageJson.dependencies["markdown-it"]).toBe("15.0.0");
    expect(packageJson.dependencies.vditor).toBeUndefined();
    expect(markdownPreview).toContain('from "markdown-it"');
    expect(markdownPreview).toContain("html: false");
    expect(markdownPreview).toContain("noopener noreferrer");
    expect(provider).toContain('data-editor-action="markdown-edit"');
    expect(provider).toContain('data-editor-action="markdown-preview"');
    expect(provider).toContain("renderMarkdownPreview(source)");
  });

  test("keeps one CodeMirror document across edit and preview modes", () => {
    expect(provider.match(/new EditorView/g)).toHaveLength(1);
    expect(provider).toContain("view.state.doc.toString()");
    expect(provider).toContain('this.#setMarkdownMode("edit")');
    expect(provider).toContain('this.#setMarkdownMode("preview")');
    expect(provider).not.toContain("<textarea");
    expect(provider).not.toContain("applySerializedEditorContent");
  });
});
