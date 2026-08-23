import { describe, expect, test } from "bun:test";
import { resolveScrollbarWidth } from "./addons/fit";
import { Ghostty } from "./ghostty";
import { calculateInputAnchor } from "./input-anchor";
import {
  applyFontCellOverrides,
  CanvasRenderer,
  calculateLinkUnderlineY,
  calculateFontMetrics,
  createThemeColorRemap,
} from "./renderer";
import { crossedDragThreshold, resolveDragRow } from "./selection-hit-test";
import { SelectionManager } from "./selection-manager";
import { calculateScrollbarGeometry } from "./scrollbar-geometry";
import { encodeLegacyMouse, encodeSgrMouse, Terminal } from "./terminal";

function cell(codepoint: number, width: number = 1) {
  return { codepoint, width, grapheme_len: 0 } as any;
}

function selectionManagerForLine(
  line: any[],
  startCol: number,
  endCol: number,
  selectionActive: boolean,
): any {
  const manager = Object.create(SelectionManager.prototype) as any;
  manager.terminal = { cols: 80, rows: 24, getViewportY: () => 0 };
  manager.renderer = { getMetrics: () => ({ width: 10, height: 19 }) };
  manager.wasmTerm = {
    getScrollbackLength: () => 0,
    getLine: (row: number) => (row === 0 ? line : null),
    getGraphemeString: () => "",
  };
  manager.selectionStart = { col: startCol, absoluteRow: 0 };
  manager.selectionEnd = { col: endCol, absoluteRow: 0 };
  manager.selectionActive = selectionActive;
  manager.isSelecting = false;
  return manager;
}

function idleRendererHarness(viewportY: number) {
  const renderedRows: number[] = [];
  let renderedCursors = 0;
  let clearedDirty = 0;
  const renderer = Object.create(CanvasRenderer.prototype) as any;
  Object.assign(renderer, {
    canvas: { width: 4, height: 3 },
    metrics: { width: 1, height: 1 },
    devicePixelRatio: 1,
    cursorBlink: true,
    cursorVisible: true,
    lastPresentedCursorVisible: viewportY === 0,
    lastCursorPosition: { x: 0, y: 0 },
    lastViewportY: viewportY,
    selectionManager: undefined,
    hoveredHyperlinkId: 0,
    previousHoveredHyperlinkId: 0,
    hoveredLinkRange: null,
    previousHoveredLinkRange: null,
    renderLine: (_line: unknown, row: number) => renderedRows.push(row),
    renderCursor: () => {
      renderedCursors += 1;
    },
  });
  const line = [cell(32), cell(32), cell(32), cell(32)];
  const buffer = {
    getCursor: () => ({ x: 0, y: 0, visible: true }),
    getDimensions: () => ({ cols: 4, rows: 3 }),
    needsFullRedraw: () => false,
    isRowDirty: () => false,
    getLine: () => line,
    clearDirty: () => {
      clearedDirty += 1;
    },
  } as any;
  const scrollback = {
    getScrollbackLength: () => 20,
    getScrollbackLine: () => line,
  } as any;
  return {
    renderer,
    buffer,
    scrollback,
    renderedRows,
    renderedCursors: () => renderedCursors,
    clearedDirty: () => clearedDirty,
  };
}

describe("local ghostty-web regressions", () => {
  test("keeps an unchanged scrolled viewport idle between animation frames", () => {
    const harness = idleRendererHarness(4);

    harness.renderer.render(harness.buffer, false, 4, harness.scrollback);

    expect(harness.renderedRows).toEqual([]);
    expect(harness.renderedCursors()).toBe(0);
    expect(harness.clearedDirty()).toBe(1);
  });

  test("redraws a blinking cursor only when its presented phase changes", () => {
    const harness = idleRendererHarness(0);

    harness.renderer.render(harness.buffer, false, 0, harness.scrollback);
    expect(harness.renderedRows).toEqual([]);
    expect(harness.renderedCursors()).toBe(0);

    harness.renderer.cursorVisible = false;
    harness.renderer.render(harness.buffer, false, 0, harness.scrollback);
    expect(harness.renderedRows).toEqual([0]);
    expect(harness.renderedCursors()).toBe(0);

    harness.renderer.cursorVisible = true;
    harness.renderer.render(harness.buffer, false, 0, harness.scrollback);
    expect(harness.renderedRows).toEqual([0, 0]);
    expect(harness.renderedCursors()).toBe(1);
  });

  test("pauses and resumes a retained terminal render loop", () => {
    const terminal = Object.create(Terminal.prototype) as any;
    terminal.isOpen = true;
    terminal.isDisposed = false;
    terminal.renderActive = true;
    terminal.animationFrameId = 17;
    terminal.viewportY = 0;
    terminal.wasmTerm = {};
    let fullRenders = 0;
    terminal.renderer = {
      render: (_buffer: unknown, forceAll: boolean) => {
        if (forceAll) fullRenders += 1;
      },
    };
    terminal.syncInputPosition = () => {};
    terminal.updateScrollbarView = () => {};
    const originalCancel = globalThis.cancelAnimationFrame;
    const originalRequest = globalThis.requestAnimationFrame;
    let canceled: number | undefined;
    let scheduled = 0;
    globalThis.cancelAnimationFrame = (handle) => {
      canceled = handle;
    };
    globalThis.requestAnimationFrame = () => ++scheduled;
    try {
      terminal.setRenderActive(false);
      expect(terminal.isRenderActive).toBe(false);
      expect(canceled).toBe(17);
      expect(terminal.animationFrameId).toBeUndefined();

      terminal.setRenderActive(true);
      expect(terminal.isRenderActive).toBe(true);
      expect(fullRenders).toBe(1);
      expect(scheduled).toBe(1);
      expect(terminal.animationFrameId).toBe(1);
    } finally {
      globalThis.cancelAnimationFrame = originalCancel;
      globalThis.requestAnimationFrame = originalRequest;
    }
  });

  test("a fresh terminal synchronizes cleared cells before its first viewport read", async () => {
    const ghostty = await Ghostty.load();
    const first = ghostty.createTerminal(80, 24);
    first.write("STALE_TERMINAL_CONTENT");
    first.update();
    expect(first.getViewport().some((cell) => cell.codepoint !== 0)).toBe(true);
    first.free();

    const second = ghostty.createTerminal(80, 24);
    try {
      expect(
        second
          .getViewport()
          .some((cell) => cell.codepoint !== 0 && cell.codepoint !== 32),
      ).toBe(false);
    } finally {
      second.free();
    }
  });

  test("link underline stays visibly inside a fixed-height cell", () => {
    expect(calculateLinkUnderlineY(18, { height: 18, baseline: 18 })).toBe(34);
    expect(calculateLinkUnderlineY(0, { height: 18, baseline: 14 })).toBe(15);
  });

  test("mouse tracking classifies links before reporting PTY clicks", async () => {
    const terminal = Object.create(Terminal.prototype) as any;
    const reports: Array<{ release: boolean }> = [];
    terminal.resolvingTrackedMouseDown = true;
    terminal.queuedTrackedMouseUp = {} as MouseEvent;
    terminal.linkDetector = { getLinkAt: async () => ({}) };
    terminal.reportMouse = (
      _event: MouseEvent,
      _button: number,
      _cell: unknown,
      release = false,
    ) => reports.push({ release });
    terminal.focus = () => {};
    terminal.mouseCell = () => ({ col: 1, row: 1 });

    await terminal.resolveTrackedMouseDown(
      {} as MouseEvent,
      0,
      { col: 1, row: 1 },
      { col: 1, row: 1 },
    );
    expect(reports).toEqual([]);
    expect(terminal.linkPointerDown).toBe(true);

    terminal.resolvingTrackedMouseDown = true;
    terminal.queuedTrackedMouseUp = {} as MouseEvent;
    terminal.linkDetector = { getLinkAt: async () => undefined };
    await terminal.resolveTrackedMouseDown(
      {} as MouseEvent,
      0,
      { col: 1, row: 1 },
      { col: 1, row: 1 },
    );
    expect(reports).toEqual([{ release: false }, { release: true }]);
  });

  test("an explicit zero scrollbar reservation uses the full terminal width", () => {
    expect(resolveScrollbarWidth("0px")).toBe(0);
    expect(resolveScrollbarWidth("")).toBe(15);
  });

  test("encodes SGR mouse clicks, releases, motion, and wheel input", () => {
    expect(encodeSgrMouse({ button: 0, col: 4, row: 2 })).toBe("\x1b[<0;5;3M");
    expect(
      encodeSgrMouse({
        button: 0,
        col: 4,
        row: 2,
        release: true,
        ctrl: true,
      }),
    ).toBe("\x1b[<16;5;3m");
    expect(encodeSgrMouse({ button: 3, col: 0, row: 0, motion: true })).toBe(
      "\x1b[<35;1;1M",
    );
    expect(encodeSgrMouse({ button: 64, col: 7, row: 9 })).toBe(
      "\x1b[<64;8;10M",
    );
  });

  test("encodes legacy mouse input with bounded one-byte coordinates", () => {
    expect(encodeLegacyMouse({ button: 0, col: 4, row: 2 })).toBe(
      `\x1b[M${String.fromCharCode(32, 37, 35)}`,
    );
    expect(
      encodeLegacyMouse({ button: 0, col: 500, row: 500, release: true }),
    ).toBe(`\x1b[M${String.fromCharCode(35, 255, 255)}`);
  });

  test("scrollbar thumb reaches both vertical track boundaries", () => {
    const bottom = calculateScrollbarGeometry(600, 100, 30, 0);
    const top = calculateScrollbarGeometry(600, 100, 30, 100);
    expect(bottom.thumbTop + bottom.thumbHeight).toBe(600);
    expect(top.thumbTop).toBe(0);
  });

  test("IME input proxy follows the rendered cursor and CSS scale", () => {
    expect(
      calculateInputAnchor(
        { left: 10, top: 64, width: 1000, height: 608 },
        27,
        21,
        100,
        32,
        { width: 10, height: 19 },
      ),
    ).toEqual({ left: 280, top: 463, width: 10, height: 19 });

    expect(
      calculateInputAnchor(
        { left: 10, top: 64, width: 500, height: 304 },
        27,
        21,
        100,
        32,
        { width: 10, height: 19 },
      ),
    ).toEqual({ left: 145, top: 263.5, width: 5, height: 9.5 });
  });

  test("Cascadia Mono uses the full font line box", () => {
    expect(
      calculateFontMetrics(
        16,
        {
          width: 9.375,
          actualBoundingBoxAscent: 11,
          actualBoundingBoxDescent: 0,
        },
        {
          actualBoundingBoxAscent: 15,
          actualBoundingBoxDescent: 4,
          fontBoundingBoxAscent: 15,
          fontBoundingBoxDescent: 4,
        },
      ),
    ).toEqual({ width: 10, height: 19, baseline: 15, boxThickness: 1 });
  });

  test("explicit cell geometry can match an xterm reference grid", () => {
    expect(
      applyFontCellOverrides(
        { width: 8, height: 17, baseline: 13, boxThickness: 1 },
        7,
        18,
      ),
    ).toEqual({ width: 7, height: 18, baseline: 13, boxThickness: 1 });
  });

  test("width-zero CJK spacer cells do not add copied spaces", () => {
    const line = [
      cell("中".codePointAt(0)!, 2),
      cell(0, 0),
      cell("文".codePointAt(0)!, 2),
      cell(0, 0),
      cell("测".codePointAt(0)!, 2),
      cell(0, 0),
      cell("试".codePointAt(0)!, 2),
      cell(0, 0),
    ];
    const manager = selectionManagerForLine(line, 0, 7, true);
    expect(manager.getSelection()).toBe("中文测试");
  });

  test("a real same-cell drag selects exactly one character", () => {
    const manager = selectionManagerForLine(
      ["A", "B"].map((char) => cell(char.codePointAt(0)!)),
      0,
      0,
      true,
    );
    expect(manager.hasSelection()).toBe(true);
    expect(manager.getSelection()).toBe("A");
  });

  test("a plain click with coincident coordinates is not a selection", () => {
    const manager = selectionManagerForLine([cell(65)], 0, 0, false);
    expect(manager.hasSelection()).toBe(false);
    expect(manager.getSelection()).toBe("");
  });

  test("drag threshold distinguishes a click from motion inside one cell", () => {
    expect(crossedDragThreshold(1, 5, 3, 5, 10)).toBe(false);
    expect(crossedDragThreshold(1, 5, 5, 5, 10)).toBe(true);
  });

  test("row endpoint cannot chatter in the gap between two lines", () => {
    const height = 19;
    const boundary = 11 * height;
    let row = 10;

    for (const delta of [-8, -1, 1, 8, -1, 1]) {
      row = resolveDragRow(
        Math.floor((boundary + delta) / height),
        row,
        boundary + delta,
        height,
      );
      expect(row).toBe(10);
    }

    row = resolveDragRow(11, row, boundary + 10, height);
    expect(row).toBe(11);

    for (const delta of [8, 1, -1, -8, 1, -1]) {
      row = resolveDragRow(
        Math.floor((boundary + delta) / height),
        row,
        boundary + delta,
        height,
      );
      expect(row).toBe(11);
    }

    row = resolveDragRow(10, row, boundary - 10, height);
    expect(row).toBe(10);
  });

  test("theme redraw remaps declared buffer colors and preserves other true RGB", () => {
    const remap = createThemeColorRemap(
      {
        foreground: "#cccccc",
        background: "#1e1e1e",
        red: "#cd3131",
      },
      {
        foreground: "#333333",
        background: "#ffffff",
        red: "#aa0000",
        bufferColorRemap: {
          "#393939": "#f4f4f4",
        },
      },
    );

    expect(remap.get(0xcccccc)).toBe("#333333");
    expect(remap.get(0x1e1e1e)).toBe("#ffffff");
    expect(remap.get(0xcd3131)).toBe("#aa0000");
    expect(remap.get(0x393939)).toBe("#f4f4f4");
    expect(remap.has(0x123456)).toBe(false);

    const reverseRemap = createThemeColorRemap(
      { background: "#ffffff" },
      {
        background: "#1e1e1e",
        bufferColorRemap: {
          "#f4f4f4": "#393939",
        },
      },
    );
    expect(reverseRemap.get(0xf4f4f4)).toBe("#393939");
  });
});
