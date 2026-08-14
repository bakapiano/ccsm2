export interface BackgroundScanOptions {
  maxBurstRuns: number;
  cooldownMs: number;
  failureThreshold: number;
  failureCooldownMs: number;
  timeoutMs: number;
}

const DEFAULT_OPTIONS: BackgroundScanOptions = {
  maxBurstRuns: 2,
  cooldownMs: 2_000,
  failureThreshold: 2,
  failureCooldownMs: 10_000,
  timeoutMs: 10_000,
};

export class BackgroundScanTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`background scan exceeded ${timeoutMs}ms`);
    this.name = "BackgroundScanTimeoutError";
  }
}

export class BackgroundScanController {
  readonly #options: BackgroundScanOptions;
  #pending = false;
  #manualPending = false;
  #running = false;
  #disposed = false;
  #drainQueued = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #burstRuns = 0;
  #consecutiveFailures = 0;
  #openUntil = 0;
  #abortController: AbortController | null = null;

  constructor(
    private readonly scan: (
      manual: boolean,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    options: Partial<BackgroundScanOptions> = {},
  ) {
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  request(manual = false): void {
    if (this.#disposed) return;
    this.#pending = true;
    this.#manualPending ||= manual;
    if (manual) {
      this.#openUntil = 0;
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
    }
    this.#queueDrain();
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = false;
    this.#manualPending = false;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  snapshot(): {
    running: boolean;
    pending: boolean;
    circuitOpen: boolean;
    consecutiveFailures: number;
  } {
    return {
      running: this.#running,
      pending: this.#pending,
      circuitOpen: this.#openUntil > Date.now(),
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  #queueDrain(): void {
    if (
      this.#disposed ||
      this.#running ||
      this.#drainQueued ||
      this.#timer !== null
    )
      return;
    const delay = this.#manualPending
      ? 0
      : Math.max(0, this.#openUntil - Date.now());
    if (delay > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#queueDrain();
      }, delay);
      return;
    }
    this.#drainQueued = true;
    queueMicrotask(() => {
      this.#drainQueued = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#disposed || this.#running || !this.#pending) return;
    const manual = this.#manualPending;
    if (!manual && this.#openUntil > Date.now()) {
      this.#queueDrain();
      return;
    }

    this.#pending = false;
    this.#manualPending = false;
    this.#running = true;
    if (manual) this.#burstRuns = 0;
    else this.#burstRuns += 1;

    let failed = false;
    let timeoutReported = false;
    const abortController = new AbortController();
    this.#abortController = abortController;
    const timeout = setTimeout(() => {
      timeoutReported = true;
      abortController.abort();
      this.onError(new BackgroundScanTimeoutError(this.#options.timeoutMs));
    }, this.#options.timeoutMs);
    try {
      await this.scan(manual, abortController.signal);
    } catch (error) {
      failed = true;
      if (!timeoutReported) this.onError(error);
    } finally {
      clearTimeout(timeout);
      if (this.#abortController === abortController)
        this.#abortController = null;
      this.#running = false;
    }

    if (failed || timeoutReported) this.#consecutiveFailures += 1;
    else this.#consecutiveFailures = 0;

    const now = Date.now();
    if (
      timeoutReported ||
      this.#consecutiveFailures >= this.#options.failureThreshold
    ) {
      this.#openUntil = now + this.#options.failureCooldownMs;
      this.#burstRuns = 0;
    } else if (!manual && this.#burstRuns >= this.#options.maxBurstRuns) {
      this.#openUntil = now + this.#options.cooldownMs;
      this.#burstRuns = 0;
    }

    if (this.#pending) this.#queueDrain();
  }
}
