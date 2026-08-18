import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

describe("application shell layout", () => {
  test("uses a full-width titlebar and gives content the remaining height", () => {
    expect(cssRule(".app-shell")).toContain(
      "grid-template-columns: var(--sidebar-width) minmax(0, 1fr)",
    );
    expect(cssRule(".app-shell")).toContain(
      "grid-template-rows: 35px minmax(0, 1fr)",
    );
    expect(cssRule(".app-titlebar")).toContain("grid-area: titlebar");
    expect(html).not.toContain('class="app-statusbar"');
  });

  test("overlays the sidebar resizer from the titlebar to the window bottom", () => {
    expect(cssRule(".sidebar-resizer")).toContain("position: absolute");
    expect(cssRule(".sidebar-resizer")).toContain(
      "left: calc(var(--sidebar-width) - 2px)",
    );
    expect(cssRule(".sidebar-resizer")).toContain("top: 35px");
    expect(cssRule(".sidebar-resizer")).toContain("bottom: 0");
  });

  test("aligns the Spaces and Agents heading text", () => {
    expect(cssRule(".sidebar-toolbar")).toContain("padding: 2px 8px");
    expect(cssRule(".agents-header")).toContain("padding: 0 8px");
  });

  test("keeps the sidebar toggle in the lower-right compact rail", () => {
    expect(html).toContain('data-testid="sidebar-toggle"');
    expect(html.match(/class="sidebar-toggle-icon"/g)).toHaveLength(1);
    expect(html).toContain('<path d="M6 2.5v11" />');
    expect(html).not.toContain("sidebar-toggle-collapse-icon");
    expect(html).not.toContain("sidebar-toggle-expand-icon");
    expect(cssRule(".sidebar-toggle")).toContain("grid-row: 5");
    expect(cssRule(".sidebar-toggle")).toContain("justify-self: end");
    expect(cssRule(".sidebar-toggle")).toContain("margin-right: 8px");
    expect(
      cssRule('.app-shell[data-sidebar-collapsed="true"] .sidebar'),
    ).toContain("grid-template-rows: minmax(0, 1fr) 32px");
    expect(
      cssRule(
        '.app-shell[data-sidebar-collapsed="true"] .sidebar > :not(.sidebar-toggle)',
      ),
    ).toContain("display: none");
  });

  test("keeps a native resize hit target above the frameless titlebar", () => {
    expect(html).toContain('id="window-resize-north"');
    expect(cssRule(".window-resize-handle")).toContain("z-index: 10000");
    expect(cssRule(".window-resize-north")).toContain("top: 0");
    expect(cssRule(".window-resize-north")).toContain("height: 5px");
    expect(cssRule(".window-resize-north")).toContain("cursor: n-resize");
  });

  test("keeps the Dockview sash hit target clear of terminal scrollbars", () => {
    const hitTarget = cssRule(
      "#dockview .dv-sash-container > .dv-sash::before",
    );
    expect(hitTarget).toContain('content: ""');
    expect(hitTarget).toContain("position: absolute");
    expect(hitTarget).toContain("inset: -1px");
    expect(hitTarget).toContain("pointer-events: auto");
  });
});

function cssRule(selector: string): string {
  const escaped = selector
    .trim()
    .split(/\s+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
