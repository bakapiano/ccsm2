import { describe, expect, test } from "bun:test";

import { planNativeVisibility } from "./browser-visibility";

import { OrderedTaskQueue } from "./ordered-task-queue";
import {
  focusWhenPanelActive,
  observePanelVisibility,
} from "./panel-visibility";

describe("native Browser visibility ordering", () => {
  test("synchronizes current bounds before showing an inactive Browser", () => {
    expect(planNativeVisibility(true)).toBe("sync-bounds-before-show");
    expect(planNativeVisibility(false)).toBe("hide-now");
  });
  test("reads Dockview initial visibility and follows later visibility events", () => {
    let visibilityListener:
      | ((event: { isVisible: boolean }) => void)
      | undefined;
    const observed: boolean[] = [];
    const subscription = observePanelVisibility(
      {
        isVisible: true,
        onDidVisibilityChange(listener) {
          visibilityListener = listener;
          return { dispose() {} };
        },
      },
      (isVisible) => observed.push(isVisible),
    );

    visibilityListener?.({ isVisible: false });
    subscription.dispose();
    expect(observed).toEqual([true, false]);
  });

  test("an inactive Terminal cannot steal focus when its runtime finishes starting", () => {
    let focusCount = 0;
    expect(focusWhenPanelActive({ isActive: false }, () => focusCount++)).toBe(
      false,
    );
    expect(focusCount).toBe(0);
    expect(focusWhenPanelActive({ isActive: true }, () => focusCount++)).toBe(
      true,
    );
    expect(focusCount).toBe(1);
  });

  test("a delayed show is always followed by the later hide", async () => {
    const queue = new OrderedTaskQueue();
    const applied: boolean[] = [];
    let releaseShow!: () => void;
    const showGate = new Promise<void>((resolve) => {
      releaseShow = resolve;
    });

    const show = queue.enqueue(
      async () => {
        await showGate;
        applied.push(true);
      },
      () => {},
    );
    const hide = queue.enqueue(
      async () => {
        applied.push(false);
      },
      () => {},
    );

    await Promise.resolve();
    expect(applied).toEqual([]);
    releaseShow();
    await Promise.all([show, hide]);
    expect(applied).toEqual([true, false]);
  });
});
