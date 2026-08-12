import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

describe("application shell layout", () => {
  test("uses VS Code-style full-width title and status bars", () => {
    expect(cssRule(".app-shell")).toContain(
      "grid-template-columns: var(--sidebar-width) minmax(0, 1fr)",
    );
    expect(cssRule(".app-shell")).toContain(
      "grid-template-rows: 35px minmax(0, 1fr) 22px",
    );
    expect(cssRule(".app-titlebar")).toContain("grid-area: titlebar");
    expect(cssRule(".app-statusbar")).toContain("grid-area: statusbar");
  });

  test("overlays the sidebar resizer between title and status bars", () => {
    expect(cssRule(".sidebar-resizer")).toContain("position: absolute");
    expect(cssRule(".sidebar-resizer")).toContain(
      "left: calc(var(--sidebar-width) - 2px)",
    );
    expect(cssRule(".sidebar-resizer")).toContain("top: 35px");
    expect(cssRule(".sidebar-resizer")).toContain("bottom: 22px");
  });

  test("keeps a native resize hit target above the frameless titlebar", () => {
    expect(html).toContain('id="window-resize-north"');
    expect(cssRule(".window-resize-handle")).toContain("z-index: 10000");
    expect(cssRule(".window-resize-north")).toContain("top: 0");
    expect(cssRule(".window-resize-north")).toContain("height: 5px");
    expect(cssRule(".window-resize-north")).toContain("cursor: n-resize");
  });

  test("expands the Dockview sash hit target without changing its layout", () => {
    const hitTarget = cssRule(
      "#dockview .dv-sash-container > .dv-sash::before",
    );
    expect(hitTarget).toContain('content: ""');
    expect(hitTarget).toContain("position: absolute");
    expect(hitTarget).toContain("inset: -6px");
    expect(hitTarget).toContain("pointer-events: auto");
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
