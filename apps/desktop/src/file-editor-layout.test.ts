import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

describe("File Editor layout", () => {
  test("pins every panel section to its intended grid row", () => {
    expect(cssRule(".file-editor-panel")).toContain(
      "grid-template-rows: 36px auto auto minmax(0, 1fr) 24px",
    );
    expect(cssRule(".file-editor-toolbar")).toContain("grid-row: 1");
    expect(cssRule(".file-editor-banner")).toContain("grid-row: 2");
    expect(cssRule(".file-editor-search")).toContain("grid-row: 3");
    expect(cssRule(".file-editor-body")).toContain("grid-row: 4");
    expect(cssRule(".file-editor-footer")).toContain("grid-row: 5");
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
