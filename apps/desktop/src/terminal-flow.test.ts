import { describe, expect, test } from "bun:test";

import {
  DebouncedTask,
  LatestValue,
  runtimeStartCanCommit,
  shouldAutoStartCliRuntime,
  TailByteBuffer,
  takeByteBatch,
} from "./terminal-flow";
import { isDockGeometrySettled } from "./terminal-layout";

describe("terminal flow control", () => {
  test("debounces a fit burst to one trailing task", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const debounce = new DebouncedTask(
      80,
      (callback) => {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle as unknown as ReturnType<typeof setTimeout>;
      },
      (handle) => callbacks.delete(handle as unknown as number),
    );
    const calls: number[] = [];

    debounce.schedule(() => calls.push(1));
    debounce.schedule(() => calls.push(2));
    debounce.schedule(() => calls.push(3));

    expect(callbacks.size).toBe(1);
    expect(debounce.pending).toBe(true);
    callbacks.values().next().value?.();
    expect(calls).toEqual([3]);
    expect(debounce.pending).toBe(false);
  });

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

  test("keeps only the tail of oversized resume output", () => {
    const buffer = new TailByteBuffer(5);
    buffer.push(new TextEncoder().encode("abc"));
    buffer.push(new TextEncoder().encode("defg"));

    expect(new TextDecoder().decode(buffer.take())).toBe("cdefg");
    expect(buffer.omittedBytes).toBe(2);
    expect(buffer.length).toBe(0);

    buffer.push(new TextEncoder().encode("123456789"));
    expect(new TextDecoder().decode(buffer.take())).toBe("56789");
    expect(buffer.omittedBytes).toBe(6);
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

  test("auto-starts visible resumable CLI sessions", () => {
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "running", nativeBindingState: "pending" },
        true,
        false,
      ),
    ).toBe(true);
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "running", nativeBindingState: "pending" },
        false,
        false,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "stopped", nativeBindingState: "bound" },
        true,
        false,
      ),
    ).toBe(true);
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "stopped", nativeBindingState: "bound" },
        false,
        false,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "stopped", nativeBindingState: "bound" },
        true,
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartCliRuntime(
        { desiredState: "stopped", nativeBindingState: "unavailable" },
        true,
        false,
      ),
    ).toBe(false);
  });
});
