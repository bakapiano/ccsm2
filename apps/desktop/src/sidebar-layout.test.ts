import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeSidebarWidth,
  resizeSidebarWidth,
} from "./sidebar-layout";

describe("resizable sidebar", () => {
  test("restores a bounded width from storage", () => {
    expect(normalizeSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth("320")).toBe(320);
    expect(normalizeSidebarWidth(20)).toBe(MIN_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(2_000)).toBe(MAX_SIDEBAR_WIDTH);
  });

  test("applies pointer deltas without leaving supported bounds", () => {
    expect(resizeSidebarWidth(232, 40)).toBe(272);
    expect(resizeSidebarWidth(232, -500)).toBe(MIN_SIDEBAR_WIDTH);
    expect(resizeSidebarWidth(232, 500)).toBe(MAX_SIDEBAR_WIDTH);
  });
});
