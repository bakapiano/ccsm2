import { describe, expect, test } from "bun:test";

import { FrameTaskScheduler } from "./frame-task-scheduler";

describe("bounded Tab restoration scheduler", () => {
  test("materializes at most two renderer tasks per animation frame", () => {
    const frames: Array<() => void> = [];
    const scheduler = new FrameTaskScheduler(
      2,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
    );
    const completed: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      scheduler.enqueue(`tab-${index}`, () => completed.push(index));
    }

    frames.shift()?.();
    expect(completed).toEqual([0, 1]);
    expect(scheduler.snapshot().pending).toBe(98);

    while (frames.length > 0) frames.shift()?.();
    expect(completed).toHaveLength(100);
  });

  test("cancels hidden renderer work before a frame runs", () => {
    const frames: Array<() => void> = [];
    const scheduler = new FrameTaskScheduler(2, (callback) => {
      frames.push(callback);
      return frames.length;
    });
    let completed = false;
    scheduler.enqueue("hidden", () => (completed = true));
    scheduler.cancel("hidden");
    frames.shift()?.();
    expect(completed).toBe(false);
  });

  test("uses a bounded fallback when animation frames are suspended", () => {
    const frames: Array<() => void> = [];
    const fallbacks: Array<() => void> = [];
    const scheduler = new FrameTaskScheduler(
      2,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
      (callback) => {
        fallbacks.push(callback);
        return fallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      () => {},
    );
    const completed: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      scheduler.enqueue(`tab-${index}`, () => completed.push(index));
    }

    fallbacks.shift()?.();
    expect(completed).toEqual([0, 1]);
    frames.shift()?.();
    expect(completed).toEqual([0, 1]);
    fallbacks.shift()?.();
    expect(completed).toEqual([0, 1, 2, 3]);
  });
});
