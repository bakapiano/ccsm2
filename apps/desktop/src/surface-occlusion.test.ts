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
});
