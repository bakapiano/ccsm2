import { describe, expect, test } from "bun:test";

import {
  TERMINAL_FONT_CELL_HEIGHT,
  TERMINAL_FONT_CELL_WIDTH,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "./terminal-typography";

describe("Terminal typography", () => {
  test("keeps the original metrics with CJK and symbol fallbacks", () => {
    const fontFamilies = TERMINAL_FONT_FAMILY.split(", ");
    expect(fontFamilies.slice(0, 4)).toEqual([
      '"Cascadia Mono"',
      '"Geist Mono"',
      '"JetBrains Mono"',
      "Consolas",
    ]);
    expect(fontFamilies).toContain('"Noto Sans SC"');
    expect(fontFamilies).toContain('"Microsoft YaHei UI"');
    expect(fontFamilies).toContain('"Segoe UI Symbol"');
    expect(fontFamilies.at(-1)).toBe("monospace");
    expect(TERMINAL_FONT_SIZE).toBe(13);
    expect(TERMINAL_FONT_CELL_WIDTH).toBe(7);
    expect(TERMINAL_FONT_CELL_HEIGHT).toBe(18);
  });
});
