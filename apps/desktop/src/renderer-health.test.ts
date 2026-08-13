import { describe, expect, test } from "bun:test";

import { takeClosestClick, type CapturedClick } from "./renderer-health";

describe("renderer input correlation", () => {
  test("matches and consumes the closest real DOM click", () => {
    const clicks: CapturedClick[] = [
      { atMs: 900, targetClass: "older" },
      { atMs: 1_040, targetClass: "closest" },
      { atMs: 1_200, targetClass: "later" },
    ];

    expect(takeClosestClick(clicks, 1_000, 250)).toEqual({
      atMs: 1_040,
      targetClass: "closest",
    });
    expect(clicks.map((click) => click.targetClass)).toEqual([
      "older",
      "later",
    ]);
  });

  test("does not reuse or invent a click outside the correlation window", () => {
    const clicks: CapturedClick[] = [{ atMs: 500, targetClass: "stale" }];
    expect(takeClosestClick(clicks, 1_000, 250)).toBeNull();
    expect(clicks).toHaveLength(1);
  });
});
