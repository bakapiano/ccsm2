import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const provider = await Bun.file(
  new URL("./tabs/file-editor-provider.ts", import.meta.url),
).text();

describe("File Editor layout", () => {
  test("pins every panel section to its intended grid row", () => {
    expect(cssRule(".file-editor-panel")).toContain(
      "grid-template-rows: var(--toolbar-height) auto minmax(0, 1fr) var(--statusbar-height)",
    );
    expect(cssRule(".file-editor-toolbar")).toContain("grid-row: 1");
    expect(cssRule(".file-editor-banner")).toContain("grid-row: 2");
    expect(cssRule(".file-editor-body")).toContain("grid-row: 3");
    expect(cssRule(".file-editor-footer")).toContain("grid-row: 4");
    expect(cssRule(".file-editor-codemirror")).toContain("height: 100%");
    expect(cssRule(".file-editor-markdown-preview")).toContain("height: 100%");
    expect(cssRule(".file-editor-markdown-preview")).toContain(
      "overflow: auto",
    );
    expect(cssRule("[tabindex]:focus-visible")).toContain(
      "outline: 1px solid var(--accent)",
    );
    expect(css).toContain('[data-editor-engine="markdown"]');
    expect(css).toContain('[data-markdown-mode="preview"]');
    expect(css).toContain('[data-markdown-mode="edit"]');
    expect(css).toContain(
      ".file-editor-markdown-preview > .markdown-preview-content",
    );
    expect(cssRule(".file-editor-markdown-modes")).toContain("display: none");
    expect(css).toContain(".file-editor-overflow-menu");
  });

  test("aligns search options and the Explorer trailing action", () => {
    expect(provider).toContain(
      '"minmax(132px, 1fr) auto auto auto auto auto auto 20px"',
    );
    expect(provider).toContain(
      '".cm-panel.cm-search > label > input[type=checkbox]"',
    );
    expect(provider).toContain('justifySelf: "start"');
    expect(provider).toContain('gridColumn: "8"');
    expect(cssRule(".file-editor-panel .cm-editor .cm-search")).toContain(
      "grid-template-columns: auto auto auto minmax(0, 1fr) auto auto auto 20px",
    );
    expect(cssRule(".files-toolbar .files-refresh")).toContain(
      "grid-column: -2 / -1",
    );
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1]
    .replace(/\s+/g, " ")
    .replace(/var\(\s+(--[^ )]+)\s+\)/g, "var($1)")
    .trim();
}
