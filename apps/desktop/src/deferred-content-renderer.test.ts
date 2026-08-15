import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GroupPanelPartInitParameters } from "dockview";

import { DeferredContentRenderer } from "./deferred-content-renderer";
import { FrameTaskScheduler } from "./frame-task-scheduler";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("one hundred restored Tabs initialize in two-per-frame batches", () => {
  const frames: Array<() => void> = [];
  const scheduler = new FrameTaskScheduler(2, (callback) => {
    frames.push(callback);
    return frames.length;
  });
  let initialized = 0;
  const renderers = Array.from(
    { length: 100 },
    (_, index) =>
      new DeferredContentRenderer(
        `tab-${index}`,
        () => ({
          element: document.createElement("div"),
          init: () => {
            initialized += 1;
          },
        }),
        scheduler,
      ),
  );
  for (const renderer of renderers) {
    renderer.init({} as GroupPanelPartInitParameters);
    renderer.onShow();
  }

  expect(initialized).toBe(0);
  frames.shift()?.();
  expect(initialized).toBe(2);
  while (frames.length > 0) frames.shift()?.();
  expect(initialized).toBe(100);
});
