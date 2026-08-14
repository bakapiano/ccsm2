import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { takeClosestClick, type CapturedClick } from "./renderer-health";
import {
  RENDERER_RECOVERY_NOTICE_DURATION_MS,
  RendererRecoveryNotice,
  type RendererRecoveryNoticeClock,
} from "./renderer-recovery-notice";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

describe("renderer input correlation", () => {
  test("matches and consumes the closest real DOM click", () => {
    const clicks: CapturedClick[] = [
      { atMs: 900, targetClass: "older" },
      { atMs: 1_040, targetClass: "closest" },
      { atMs: 1_200, targetClass: "later" },
    ];

    expect(takeClosestClick(clicks, 1_000, 250)).toEqual({
      atMs: 1_040,
      targetClass: "closest",
    });
    expect(clicks.map((click) => click.targetClass)).toEqual([
      "older",
      "later",
    ]);
  });

  test("does not reuse or invent a click outside the correlation window", () => {
    const clicks: CapturedClick[] = [{ atMs: 500, targetClass: "stale" }];
    expect(takeClosestClick(clicks, 1_000, 250)).toBeNull();
    expect(clicks).toHaveLength(1);
  });
});

describe("renderer recovery notice", () => {
  test("dismisses automatically after the recovery display interval", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const clock = new ManualClock();
    const notice = new RendererRecoveryNotice(root, undefined, clock);

    notice.show({ state: "ready", recovered: true, incidentId: "abcdef1234" });

    expect(root.querySelector(".renderer-recovery-notice")?.textContent).toBe(
      "UI recoveredInput path restored · incident abcdef12×",
    );
    expect(clock.delays).toEqual([RENDERER_RECOVERY_NOTICE_DURATION_MS]);

    clock.run(1);

    expect(root.querySelector(".renderer-recovery-notice")).toBeNull();
  });

  test("restarts the interval for the latest recovery and clears it on dismiss", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const clock = new ManualClock();
    const notice = new RendererRecoveryNotice(root, undefined, clock);

    notice.show({ state: "ready", recovered: true, incidentId: "first" });
    notice.show({ state: "ready", recovered: true, incidentId: "second" });

    expect(clock.cleared).toEqual([1]);
    clock.runCanceled(1);
    expect(
      root.querySelector(".renderer-recovery-notice")?.textContent,
    ).toContain("second");

    root
      .querySelector<HTMLButtonElement>(
        "button[aria-label='Dismiss recovery notice']",
      )
      ?.click();

    expect(clock.cleared).toEqual([1, 2]);
    expect(root.querySelector(".renderer-recovery-notice")).toBeNull();
  });
});

class ManualClock implements RendererRecoveryNoticeClock {
  readonly delays: number[] = [];
  readonly cleared: number[] = [];
  readonly #callbacks = new Map<number, () => void>();
  readonly #active = new Set<number>();
  #nextId = 1;

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.delays.push(delayMs);
    this.#callbacks.set(id, callback);
    this.#active.add(id);
    return id;
  }

  clearTimeout(timeoutId: number): void {
    this.cleared.push(timeoutId);
    this.#active.delete(timeoutId);
  }

  run(timeoutId: number): void {
    if (!this.#active.delete(timeoutId)) return;
    this.#callbacks.get(timeoutId)?.();
  }

  runCanceled(timeoutId: number): void {
    this.#callbacks.get(timeoutId)?.();
  }
}
