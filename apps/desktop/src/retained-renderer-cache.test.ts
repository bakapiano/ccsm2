import { describe, expect, test } from "bun:test";

import { RetainedRendererCache } from "./retained-renderer-cache";

describe("Terminal renderer retention", () => {
  test("reuses one VT instance across Space detach/reattach and destroys it on release", () => {
    const cache = new RetainedRendererCache<{
      destroy(): void;
      marker: string;
    }>();
    let createCount = 0;
    let destroyCount = 0;
    const create = () => ({
      marker: `terminal-${++createCount}`,
      destroy: () => destroyCount++,
    });

    const first = cache.getOrCreate("tab-1", create);
    const restored = cache.getOrCreate("tab-1", create);
    expect(restored).toBe(first);
    expect(createCount).toBe(1);

    cache.release(["tab-1"]);
    expect(destroyCount).toBe(1);
    expect(cache.getOrCreate("tab-1", create)).not.toBe(first);
  });

  test("broadcasts updates to every retained renderer", () => {
    const cache = new RetainedRendererCache<{
      destroy(): void;
      marker: string;
    }>();
    cache.getOrCreate("tab-1", () => ({ marker: "one", destroy() {} }));
    cache.getOrCreate("tab-2", () => ({ marker: "two", destroy() {} }));
    const markers: string[] = [];

    cache.forEach((renderer) => markers.push(renderer.marker));

    expect(markers).toEqual(["one", "two"]);
  });
});
