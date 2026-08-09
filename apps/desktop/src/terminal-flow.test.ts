import { describe, expect, test } from "bun:test";

import {
  LatestValue,
  runtimeStartCanCommit,
  takeByteBatch,
} from "./terminal-flow";
import { isDockGeometrySettled } from "./terminal-layout";

describe("terminal flow control", () => {
  test("coalesces a resize burst to the latest dimensions", () => {
    const pending = new LatestValue<{ cols: number; rows: number }>();
    pending.set({ cols: 80, rows: 24 });
    pending.set({ cols: 140, rows: 52 });

    expect(pending.take()).toEqual({ cols: 140, rows: 52 });
    expect(pending.take()).toBeUndefined();
  });

  test("bounds each terminal output render batch", () => {
    const queue = [
      new Uint8Array(100),
      new Uint8Array(100),
      new Uint8Array(100),
    ];
    const batch = takeByteBatch(queue, 200);

    expect(batch?.byteLength).toBe(200);
    expect(queue).toHaveLength(1);
  });

  test("rejects transient geometry from the previous Space layout", () => {
    const apiSize = { width: 544, height: 742 };
    const settledGroup = {
      left: 260,
      top: 58,
      right: 804,
      bottom: 800,
      width: 544,
      height: 742,
    };
    const settledPanel = {
      left: 260,
      top: 93,
      right: 804,
      bottom: 800,
      width: 544,
      height: 707,
    };
    const stalePanel = { ...settledPanel, right: 1320, width: 1060 };

    expect(isDockGeometrySettled(apiSize, settledGroup, stalePanel)).toBe(
      false,
    );
    expect(isDockGeometrySettled(apiSize, settledGroup, settledPanel)).toBe(
      true,
    );
  });

  test("does not resurrect a runtime that exited before start returned", () => {
    expect(runtimeStartCanCommit(new Set(["runtime-1"]), "runtime-1")).toBe(
      false,
    );
    expect(runtimeStartCanCommit(new Set(), "runtime-1")).toBe(true);
  });
});
