import { describe, expect, test } from "bun:test";

import {
  GIT_DIFF_OVERSCAN_ROWS,
  GIT_DIFF_ROW_HEIGHT,
  gitDiffVirtualWindow,
} from "./git-diff-window";

describe("Git diff row window", () => {
  test("keeps the mounted range bounded for a two-million-line diff", () => {
    const viewportRows = 40;
    const window = gitDiffVirtualWindow(
      2_000_000,
      1_000_000 * GIT_DIFF_ROW_HEIGHT,
      (1_000_000 + viewportRows) * GIT_DIFF_ROW_HEIGHT,
    );

    expect(window.end - window.start).toBe(
      viewportRows + GIT_DIFF_OVERSCAN_ROWS * 2,
    );
    expect(window.paddingBefore + window.paddingAfter).toBe(
      (2_000_000 - (window.end - window.start)) * GIT_DIFF_ROW_HEIGHT,
    );
  });

  test("returns one full-height spacer while a diff is outside the viewport", () => {
    expect(gitDiffVirtualWindow(50_000, -1_000, -500)).toEqual({
      start: 0,
      end: 0,
      paddingBefore: 0,
      paddingAfter: 1_000_000,
    });
  });

  test("clamps the tail window to the final row", () => {
    const window = gitDiffVirtualWindow(100, 1_900, 2_100, 20, 5);
    expect(window).toEqual({
      start: 90,
      end: 100,
      paddingBefore: 1_800,
      paddingAfter: 0,
    });
  });
});
