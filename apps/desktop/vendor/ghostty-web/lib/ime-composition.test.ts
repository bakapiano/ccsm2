import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Ghostty } from "./ghostty";
import { Terminal } from "./terminal";

GlobalRegistrator.register();

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

function domRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeCanvasContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    canvas,
    fillStyle: "#000000",
    strokeStyle: "#ffffff",
    font: "16px monospace",
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    measureText: (text: string) => ({
      width: text.length * 9.375,
      actualBoundingBoxAscent: text === "M" ? 11 : 15,
      actualBoundingBoxDescent: text === "M" ? 0 : 4,
      fontBoundingBoxAscent: 15,
      fontBoundingBoxDescent: 4,
    }),
  };

  return new Proxy(state, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => {};
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function compositionEvent(type: string, data: string): CompositionEvent {
  const event = new CompositionEvent(type, { bubbles: true });
  // happy-dom currently ignores CompositionEventInit.data; define it the same
  // way Chromium exposes the readonly payload.
  Object.defineProperty(event, "data", { configurable: true, value: data });
  return event;
}

beforeEach(() => {
  document.body.replaceChildren();
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement) {
      return makeCanvasContext(this);
    },
  });

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement) {
      if (this.tagName === "CANVAS") return domRect(10, 64, 800, 456);

      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      const minWidth = Number.parseFloat(this.style.minWidth) || 0;
      const styledWidth = Number.parseFloat(this.style.width) || 0;
      const textWidth = this.hasAttribute("data-ghostty-composition")
        ? (this.textContent?.replace(/\u200e/g, "").length ?? 0) * 9.375 + 2
        : 0;
      const width = Math.max(minWidth, styledWidth, textWidth);
      const height = Number.parseFloat(this.style.height) || 0;
      return domRect(left, top, width, height);
    },
  });
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  document.body.replaceChildren();
});

describe("IME composition overlay", () => {
  test("anchors the scrollbar overlay to the terminal host right edge", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({ ghostty, cols: 80, rows: 24 });
    const host = document.createElement("div");
    document.body.append(host);
    terminal.open(host);

    const scrollbar = host.querySelector<HTMLElement>(
      "[data-ghostty-scrollbar]",
    )!;
    expect(scrollbar.style.position).toBe("absolute");
    expect(scrollbar.style.right).toBe("0px");
    expect(scrollbar.style.width).toBe("8px");
    expect(
      scrollbar.querySelector("[data-ghostty-scrollbar-thumb]"),
    ).not.toBeNull();

    terminal.dispose();
  });

  test("renders preedit at the cursor without mutating VT and commits exactly once", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 80,
      rows: 24,
      fontFamily: '"Cascadia Mono", monospace',
      fontSize: 16,
      theme: {
        background: "#111318",
        foreground: "#d8dee9",
        cursor: "#8fbcbb",
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const submitted: string[] = [];
    terminal.onData((data) => submitted.push(data));

    terminal.open(host);
    terminal.focus();
    expect(document.activeElement).toBe(terminal.textarea!);

    const overlay = host.querySelector<HTMLElement>(
      "[data-ghostty-composition]",
    )!;
    const before =
      terminal.buffer.active.getLine(0)?.translateToString(false) ?? "";
    terminal.textarea!.dispatchEvent(compositionEvent("compositionstart", ""));
    terminal.textarea!.dispatchEvent(
      compositionEvent("compositionupdate", "wo'ai'ni"),
    );

    const during =
      terminal.buffer.active.getLine(0)?.translateToString(false) ?? "";
    expect(during).toBe(before);
    expect(submitted).toEqual([]);
    expect(overlay.style.display).toBe("block");
    expect(overlay.textContent?.replace(/\u200e/g, "")).toBe("wo'ai'ni");
    expect(overlay.style.left).toBe("10px");
    expect(overlay.style.top).toBe("64px");
    expect(overlay.style.height).toBe("19px");
    expect(overlay.style.borderRight).toBe("2px solid #8fbcbb");
    expect(overlay.style.boxShadow).toContain("inset");
    expect(Number.parseFloat(terminal.textarea!.style.width)).toBeGreaterThan(
      10,
    );

    terminal.textarea!.dispatchEvent(
      compositionEvent("compositionend", "我爱你"),
    );
    await Promise.resolve();

    expect(submitted).toEqual(["我爱你"]);
    expect(overlay.style.display).toBe("none");
    expect(overlay.textContent).toBe("");
    expect(terminal.textarea!.value).toBe("");

    terminal.write("dirty screen");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "dirty screen",
    );
    terminal.reset();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");

    terminal.dispose();
  });

  test("incoming output preserves a user-controlled scrollback anchor", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 5,
      scrollback: 1024 * 1024,
      fontSize: 16,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    terminal.open(host);

    for (let index = 0; index < 16; index++) {
      terminal.writeln(`line-${index}`);
    }
    expect(terminal.getScrollbackLength()).toBeGreaterThan(5);

    terminal.scrollLines(-3);
    const anchorBefore = terminal.getViewportY();
    const scrollbackBefore = terminal.getScrollbackLength();
    expect(anchorBefore).toBe(3);

    terminal.writeln("appended-output");
    const appendedLines = terminal.getScrollbackLength() - scrollbackBefore;
    expect(appendedLines).toBeGreaterThan(0);
    expect(terminal.getViewportY()).toBe(anchorBefore + appendedLines);
    expect((terminal as any).targetViewportY).toBe(
      anchorBefore + appendedLines,
    );

    const anchoredAfterAppend = terminal.getViewportY();
    terminal.write("\rthinking-frame");
    expect(terminal.getViewportY()).toBe(anchoredAfterAppend);

    terminal.scrollToBottom();
    terminal.writeln("followed-output");
    expect(terminal.getViewportY()).toBe(0);
    expect((terminal as any).targetViewportY).toBe(0);

    terminal.dispose();
  });

  test("theme redraw preserves the VT screen and scrollback position", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 5,
      scrollback: 1024 * 1024,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        red: "#cd3131",
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    terminal.open(host);
    for (let index = 0; index < 16; index++) {
      terminal.writeln(`line-${index}`);
    }
    terminal.scrollLines(-3);
    const beforeText = terminal.buffer.active
      .getLine(2)
      ?.translateToString(true);
    const beforeScrollback = terminal.getScrollbackLength();
    const beforeViewport = terminal.getViewportY();

    terminal.options.theme = {
      background: "#ffffff",
      foreground: "#333333",
      red: "#aa0000",
    };

    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe(
      beforeText,
    );
    expect(terminal.getScrollbackLength()).toBe(beforeScrollback);
    expect(terminal.getViewportY()).toBe(beforeViewport);
    terminal.dispose();
  });
});
