export type FrameSchedule = (callback: () => void) => number;
export type FrameCancel = (handle: number) => void;
export type FallbackSchedule = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;
export type FallbackCancel = (handle: ReturnType<typeof setTimeout>) => void;

export class FrameTaskScheduler {
  readonly #tasks = new Map<string, () => void>();
  readonly #order: string[] = [];
  #frame: number | null = null;
  #fallback: ReturnType<typeof setTimeout> | null = null;
  #scheduleVersion = 0;

  constructor(
    private readonly maxTasksPerFrame = 2,
    private readonly schedule: FrameSchedule = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancelFrame: FrameCancel = (handle) =>
      globalThis.cancelAnimationFrame?.(handle),
    private readonly scheduleFallback: FallbackSchedule = (callback, delayMs) =>
      setTimeout(callback, delayMs),
    private readonly cancelFallback: FallbackCancel = (handle) =>
      clearTimeout(handle),
    private readonly fallbackDelayMs = 100,
  ) {}

  enqueue(id: string, task: () => void, priority = false): void {
    if (this.#tasks.has(id)) {
      this.#tasks.set(id, task);
      if (priority) {
        const index = this.#order.indexOf(id);
        if (index >= 0) this.#order.splice(index, 1);
        this.#order.unshift(id);
      }
    } else {
      this.#tasks.set(id, task);
      if (priority) this.#order.unshift(id);
      else this.#order.push(id);
    }
    this.#ensureFrame();
  }

  cancel(id: string): void {
    this.#tasks.delete(id);
    const index = this.#order.indexOf(id);
    if (index >= 0) this.#order.splice(index, 1);
  }

  clear(): void {
    this.#tasks.clear();
    this.#order.length = 0;
    if (this.#frame !== null) this.cancelFrame(this.#frame);
    if (this.#fallback !== null) this.cancelFallback(this.#fallback);
    this.#frame = null;
    this.#fallback = null;
    this.#scheduleVersion += 1;
  }

  snapshot(): {
    pending: number;
    frameScheduled: boolean;
    fallbackScheduled: boolean;
  } {
    return {
      pending: this.#tasks.size,
      frameScheduled: this.#frame !== null,
      fallbackScheduled: this.#fallback !== null,
    };
  }

  #ensureFrame(): void {
    if (
      this.#frame !== null ||
      this.#fallback !== null ||
      this.#tasks.size === 0
    ) {
      return;
    }
    const version = ++this.#scheduleVersion;
    this.#frame = this.schedule(() => this.#drainFrame(version));
    this.#fallback = this.scheduleFallback(
      () => this.#drainFrame(version),
      Math.max(1, this.fallbackDelayMs),
    );
  }

  #drainFrame(version: number): void {
    if (version !== this.#scheduleVersion) return;
    if (this.#frame !== null) this.cancelFrame(this.#frame);
    if (this.#fallback !== null) this.cancelFallback(this.#fallback);
    this.#frame = null;
    this.#fallback = null;
    const limit = Math.max(1, Math.floor(this.maxTasksPerFrame));
    for (let count = 0; count < limit; count += 1) {
      const id = this.#order.shift();
      if (!id) break;
      const task = this.#tasks.get(id);
      this.#tasks.delete(id);
      task?.();
    }
    this.#ensureFrame();
  }
}
