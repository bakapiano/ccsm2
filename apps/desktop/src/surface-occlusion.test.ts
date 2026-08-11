import { describe, expect, test } from "bun:test";

import { SurfaceOcclusionController } from "./surface-occlusion";

describe("native surface occlusion", () => {
  test("keeps Browser surfaces hidden until every overlapping UI layer closes", async () => {
    const applied: boolean[] = [];
    const controller = new SurfaceOcclusionController(async (occluded) => {
      applied.push(occluded);
    });

    await controller.set("new-tab-menu", true);
    await controller.set("directory-dialog", true);
    await controller.set("new-tab-menu", false);
    expect(controller.occluded).toBe(true);
    await controller.set("directory-dialog", false);

    expect(controller.occluded).toBe(false);
    expect(applied).toEqual([true, false]);
  });

  test("serializes a close behind an in-flight snapshot transition", async () => {
    const applied: boolean[] = [];
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const controller = new SurfaceOcclusionController(async (occluded) => {
      if (occluded) await captureGate;
      applied.push(occluded);
    });

    const open = controller.set("menu", true);
    await Promise.resolve();
    const close = controller.set("menu", false);
    expect(controller.occluded).toBe(false);
    expect(applied).toEqual([]);

    releaseCapture();
    await Promise.all([open, close]);
    expect(applied).toEqual([true, false]);
  });
});
