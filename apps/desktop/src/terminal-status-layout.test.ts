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
    expect(cssRule(".terminal-host")).toContain(
      "--terminal-fit-scrollbar-width: 0px",
    );
    expect(cssRule(".terminal-host")).toContain("padding: 7px 0 4px");
  });

  test("guards long-scrollback resize bursts with trailing fit debounce", () => {
    expect(provider).toContain("const SCROLLBACK_BYTES = 64 * 1024 * 1024");
    expect(provider).toContain("scrollback: SCROLLBACK_BYTES");
    expect(provider).toContain("const FIT_DEBOUNCE_MS = 80");
    expect(provider).toContain("new TerminalFitSettler(FIT_DEBOUNCE_MS");
    expect(provider).toContain("this.#fitSettler.beginResizeGesture()");
    expect(provider).toContain("isRenderableTerminalViewport(");
    expect(provider).toContain("this.#terminal.redraw()");
    expect(provider).toContain("this.#frameSwap.capture(");
    expect(provider).toContain("this.#frameSwap.matches(size)");
    expect(provider).toContain("this.#frameSwap.release()");
    expect(provider).toContain('captured.completion === "synchronized"');
    expect(provider).toContain('captured.completion === "cursor"');
    expect(provider).toContain("extractClaudeSynchronizedRepaint(");
    expect(provider).toContain("extractClaudeCursorPositionedRepaint(");
    expect(provider).toContain("new ResizeOutputSettler(");
    expect(provider).toContain("CODEX_REPAINT_QUIET_MS = 200");
    expect(provider).toContain("await this.#waitForOutputDrain()");
    expect(
      cssRule(
        '.terminal-panel[data-resize-pending="true"] .terminal-host canvas',
      ),
    ).toContain("max-width: none");
    expect(cssRule(".terminal-resize-snapshot")).toContain(
      "pointer-events: none",
    );
    expect(css).toContain('data-resize-snapshot="true"');
    expect(css).toContain("canvas:not(.terminal-resize-snapshot)");
    expect(css).toContain("visibility: hidden");
    expect(provider).toContain("this.#scheduleFit(true)");
  });

  test("commits only a validated full Claude repaint on width changes", () => {
    expect(provider).toContain("// Claude-only fix:");
    expect(provider).toContain("shouldRunClaudeHistoryRepaint({");
    expect(provider).toContain("terminal.cols === size.cols");
    expect(provider).toContain("extractClaudeFullRepaint(");
    expect(provider).toContain("terminal.replaceBufferWithRepaint(repaint)");
    expect(provider).toContain("this.#historyRepaintFailureCount += 1");
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}
