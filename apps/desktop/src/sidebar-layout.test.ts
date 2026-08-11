import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENTS_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  maxAgentsHeight,
  MIN_AGENTS_HEIGHT,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeAgentsHeight,
  normalizeSidebarWidth,
  resizeAgentsHeight,
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

  test("resizes Agents while preserving a usable Space tree", () => {
    expect(maxAgentsHeight(900)).toBe(767);
    expect(normalizeAgentsHeight(null, 900)).toBe(DEFAULT_AGENTS_HEIGHT);
    expect(normalizeAgentsHeight(20, 900)).toBe(MIN_AGENTS_HEIGHT);
    expect(normalizeAgentsHeight(2_000, 900)).toBe(767);
    expect(resizeAgentsHeight(280, -40, 900)).toBe(320);
    expect(resizeAgentsHeight(280, 500, 900)).toBe(MIN_AGENTS_HEIGHT);
  });
});
