import { describe, expect, test } from "bun:test";

import {
  TERMINAL_FONT_CELL_HEIGHT,
  TERMINAL_FONT_CELL_WIDTH,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "./terminal-typography";

describe("Terminal typography", () => {
  test("matches the original CCSM desktop terminal", () => {
    expect(TERMINAL_FONT_FAMILY).toBe(
      '"Cascadia Mono", "Geist Mono", "JetBrains Mono", Consolas, monospace',
    );
    expect(TERMINAL_FONT_SIZE).toBe(13);
    expect(TERMINAL_FONT_CELL_WIDTH).toBe(7);
    expect(TERMINAL_FONT_CELL_HEIGHT).toBe(18);
  });
});
