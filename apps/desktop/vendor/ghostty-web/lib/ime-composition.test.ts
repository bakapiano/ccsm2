import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Ghostty } from "./ghostty";
import { Terminal } from "./terminal";

GlobalRegistrator.register();

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
let canvasViewportRect = domRect(10, 64, 800, 456);
let canvasLayoutRect = { left: 10, top: 64, width: 800, height: 456 };

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
  canvasViewportRect = domRect(10, 64, 800, 456);
  canvasLayoutRect = { left: 10, top: 64, width: 800, height: 456 };
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
      if (this.tagName === "CANVAS") return canvasViewportRect;

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

  for (const [property, key] of [
    ["offsetLeft", "left"],
    ["offsetTop", "top"],
    ["offsetWidth", "width"],
    ["offsetHeight", "height"],
  ] as const) {
    Object.defineProperty(HTMLCanvasElement.prototype, property, {
      configurable: true,
      get: () => canvasLayoutRect[key],
    });
  }
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

  test("anchors IME in canvas layout coordinates inside a transformed panel", async () => {
    canvasViewportRect = domRect(242, 107, 800, 456);
    canvasLayoutRect = { left: 8, top: 7, width: 800, height: 456 };
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({ ghostty, cols: 80, rows: 24 });
    const host = document.createElement("div");
    document.body.append(host);
    terminal.open(host);
    terminal.focus();

    terminal.textarea!.dispatchEvent(compositionEvent("compositionstart", ""));
    terminal.textarea!.dispatchEvent(
      compositionEvent("compositionupdate", "ni'hao"),
    );
    const overlay = host.querySelector<HTMLElement>(
      "[data-ghostty-composition]",
    )!;

    expect(terminal.textarea!.style.position).toBe("absolute");
    expect(terminal.textarea!.style.left).toBe("8px");
    expect(terminal.textarea!.style.top).toBe("7px");
    expect(overlay.style.position).toBe("absolute");
    expect(overlay.style.left).toBe("8px");
    expect(overlay.style.top).toBe("7px");

    terminal.dispose();
  });

  test("a new terminal clears cells released by a disposed terminal", async () => {
    const ghostty = await Ghostty.load();
    const firstHost = document.createElement("div");
    document.body.append(firstHost);
    const first = new Terminal({ ghostty, cols: 80, rows: 24 });
    first.open(firstHost);
    first.write("OLD_TERMINAL_CONTENT_MUST_NOT_SURVIVE");
    expect(first.buffer.active.getLine(0)?.translateToString(true)).toContain(
      "OLD_TERMINAL_CONTENT_MUST_NOT_SURVIVE",
    );
    first.dispose();

    const secondHost = document.createElement("div");
    document.body.append(secondHost);
    const second = new Terminal({ ghostty, cols: 80, rows: 24 });
    second.open(secondHost);

    expect(second.buffer.active.getLine(0)?.translateToString(true)).toBe("");
    expect(secondHost.textContent).not.toContain(
      "OLD_TERMINAL_CONTENT_MUST_NOT_SURVIVE",
    );
    second.dispose();
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

  test("reports current theme colors to agent CLI dynamic-color queries", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 5,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const responses: string[] = [];
    const titles: string[] = [];
    let bellCount = 0;
    terminal.onData((data) => responses.push(data));
    terminal.onTitleChange((title) => titles.push(title));
    terminal.onBell(() => {
      bellCount += 1;
    });
    terminal.open(host);

    terminal.write("\x1b]10;?\x07\x1b]11;?\x1b\\");
    expect(responses).toEqual([
      "\x1b]10;rgb:cccc/cccc/cccc\x07",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
    ]);
    expect(bellCount).toBe(0);

    terminal.options.theme = {
      background: "#ffffff",
      foreground: "#333333",
      cursor: "#000000",
    };
    terminal.write(new TextEncoder().encode("\x1b]1"));
    terminal.write(new TextEncoder().encode("1;?\x1b\\"));
    expect(responses.at(-1)).toBe("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    terminal.write("\x1b]2;light terminal\x1b\\");
    expect(titles).toEqual(["light terminal"]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");
    terminal.dispose();
  });

  test("explicit redraw preserves VT contents and viewport", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 5,
      scrollback: 1024 * 1024,
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

    terminal.redraw();

    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe(
      beforeText,
    );
    expect(terminal.getScrollbackLength()).toBe(beforeScrollback);
    expect(terminal.getViewportY()).toBe(beforeViewport);
    terminal.dispose();
  });

  test("frame snapshot copies the presented Canvas without changing VT", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({ ghostty, cols: 20, rows: 5 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    terminal.open(host);
    terminal.writeln("snapshot-marker");
    const beforeText = terminal.buffer.active
      .getLine(0)
      ?.translateToString(true);

    const snapshot = terminal.createFrameSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot?.dataset.ghosttyFrameSnapshot).toBe("true");
    expect(snapshot?.getAttribute("aria-hidden")).toBe("true");
    expect(snapshot?.style.left).toBe("10px");
    expect(snapshot?.style.top).toBe("64px");
    expect(snapshot?.style.width).toBe("800px");
    expect(snapshot?.style.height).toBe("456px");
    expect(host.contains(snapshot!)).toBe(false);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      beforeText,
    );
    terminal.dispose();
  });

  test("resize reflows history even when a TUI disables DEC wraparound", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 4,
      scrollback: 1024 * 1024,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    terminal.open(host);

    terminal.writeln("marker-ABCDEFGHIJKL");
    for (let index = 0; index < 12; index += 1) {
      terminal.writeln(`history-${index}`);
    }
    expect(terminal.buffer.active.length).toBeGreaterThan(terminal.rows);

    terminal.write("\x1b[?7l");
    terminal.resize(10, 4);

    let text = "";
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      text += terminal.buffer.active.getLine(index)?.translateToString(true);
    }
    expect(text).toContain("marker-ABCDEFGHIJKL");

    terminal.dispose();
  });

  test("validated repaint replaces history without resetting input modes", async () => {
    const ghostty = await Ghostty.load();
    const terminal = new Terminal({
      ghostty,
      cols: 20,
      rows: 4,
      scrollback: 1024 * 1024,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    terminal.open(host);
    for (let index = 0; index < 10; index += 1) {
      terminal.writeln(`old-${index}`);
    }
    terminal.write("\x1b[?2004h");

    const replies: string[] = [];
    terminal.onData((data) => replies.push(data));
    terminal.replaceBufferWithRepaint(
      new TextEncoder().encode(
        "\x1b[Hfresh-0\r\nfresh-1\r\nfresh-2\r\nfresh-3\r\nfresh-4\r\n\x1b[6n",
      ),
    );

    const text: string[] = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      text.push(
        terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
      );
    }
    expect(text.join("\n")).not.toContain("old-");
    expect(text.join("\n")).toContain("fresh-0");
    expect(terminal.wasmTerm?.hasBracketedPaste()).toBe(true);
    expect(replies).toEqual([]);

    terminal.dispose();
  });
});
