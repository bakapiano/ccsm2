import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

describe("File Editor layout", () => {
  test("pins every panel section to its intended grid row", () => {
    expect(cssRule(".file-editor-panel")).toContain(
      "grid-template-rows: var(--toolbar-height) auto minmax(0, 1fr) var(--statusbar-height)",
    );
    expect(
      cssRule('.file-editor-panel[data-editor-engine="vditor-ir"]'),
    ).toContain(
      "grid-template-rows: 0 auto minmax(0, 1fr) var(--statusbar-height)",
    );
    expect(cssRule(".file-editor-toolbar")).toContain("grid-row: 1");
    expect(cssRule(".file-editor-banner")).toContain("grid-row: 2");
    expect(cssRule(".file-editor-body")).toContain("grid-row: 3");
    expect(cssRule(".file-editor-footer")).toContain("grid-row: 4");
    expect(cssRule(".file-editor-codemirror")).toContain("height: 100%");
    expect(cssRule(".file-editor-vditor")).toContain("height: 100%");
    expect(css).toContain('[data-editor-engine="vditor-ir"]');
    expect(css).toContain("file-editor-vditor-save");
    expect(cssRule(".file-editor-vditor .vditor-toolbar")).toContain(
      "flex-wrap: nowrap",
    );
    expect(cssRule(".file-editor-vditor .vditor-toolbar")).toContain(
      "scrollbar-width: none",
    );
    expect(css).toContain(".file-editor-overflow-menu");
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
