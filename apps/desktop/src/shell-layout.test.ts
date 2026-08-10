import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

describe("application shell layout", () => {
  test("overlays the sidebar resizer without adding a gap before Dockview", () => {
    expect(cssRule(".app-shell")).toContain(
      "grid-template-columns: var(--sidebar-width) minmax(0, 1fr)",
    );
    expect(cssRule(".sidebar-resizer")).toContain("position: absolute");
    expect(cssRule(".sidebar-resizer")).toContain(
      "left: calc(var(--sidebar-width) - 2px)",
    );
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
