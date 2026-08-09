import { describe, expect, test } from "bun:test";

import { BackgroundScanController } from "./background-scan";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("background scan circuit breaker", () => {
  test("keeps scans single-flight and folds a burst into one follow-up", async () => {
    const releases: Array<() => void> = [];
    let runs = 0;
    const controller = new BackgroundScanController(
      async () => {
        runs += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      },
      () => {},
      { maxBurstRuns: 10 },
    );

    controller.request();
    await tick();
    controller.request();
    controller.request();
    expect(runs).toBe(1);
    releases.shift()?.();
    await tick();
    expect(runs).toBe(2);
    releases.shift()?.();
    await tick();
    expect(controller.snapshot().running).toBe(false);
    controller.dispose();
  });

  test("opens a cooldown after the configured burst budget", async () => {
    let runs = 0;
    const controller = new BackgroundScanController(
      async () => {
        runs += 1;
      },
      () => {},
      { maxBurstRuns: 1, cooldownMs: 200 },
    );

    controller.request();
    await tick();
    await tick();
    controller.request();
    await tick();
    expect(runs).toBe(1);
    expect(controller.snapshot().circuitOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(runs).toBe(2);
    controller.dispose();
  });
});
