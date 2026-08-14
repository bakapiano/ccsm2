import { expect, test } from "bun:test";
import { Orientation } from "dockview";

import { deferredDockviewSnapshot } from "./dock-restore";

test("restored panels use deferred content mounting", () => {
  const panels = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `tab-${index}`,
      {
        id: `tab-${index}`,
        contentComponent: "cli-session",
        renderer: "always" as const,
      },
    ]),
  );
  const snapshot = {
    grid: {
      root: { type: "branch" as const, data: [] },
      height: 800,
      width: 1200,
      orientation: Orientation.HORIZONTAL,
    },
    panels,
  };

  const restored = deferredDockviewSnapshot(snapshot);
  expect(
    Object.values(restored.panels).every(
      (panel) => panel.renderer === "onlyWhenVisible",
    ),
  ).toBe(true);
  expect(Object.values(panels)[0]?.renderer).toBe("always");
});
