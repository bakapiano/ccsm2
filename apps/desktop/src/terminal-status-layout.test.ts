import { describe, expect, test } from "bun:test";

const provider = await Bun.file(
  new URL("./tabs/terminal-provider.ts", import.meta.url),
).text();
const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

describe("Terminal status layout", () => {
  test("renders the terminal host above a fixed bottom status bar", () => {
    expect(provider.indexOf('class="terminal-host"')).toBeLessThan(
      provider.indexOf('class="terminal-panel-toolbar"'),
    );
    expect(cssRule(".terminal-panel")).toContain(
      "grid-template-rows: minmax(0, 1fr) 30px",
    );
    expect(cssRule(".terminal-panel-toolbar")).toContain(
      "border-top: 1px solid var(--term-rule)",
    );
  });

  test("guards long-scrollback resize bursts with trailing fit debounce", () => {
    expect(provider).toContain("const FIT_DEBOUNCE_MS = 80");
    expect(provider).toContain("new DebouncedTask(FIT_DEBOUNCE_MS)");
    expect(provider).toContain(
      "this.#fitDebounce.schedule(() => this.#requestFitFrame())",
    );
    expect(provider).toContain("this.#scheduleFit(true)");
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
