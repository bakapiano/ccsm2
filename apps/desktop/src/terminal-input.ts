export interface TerminalInputWriterSnapshot {
  enqueuedEvents: number;
  writeBatches: number;
  pendingEvents: number;
  pendingCodeUnits: number;
  writeInFlight: boolean;
}

interface PendingInput {
  runtimeId: string;
  data: string;
  events: number;
}

export class TerminalInputWriter {
  readonly #pending: PendingInput[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #writeInFlight = false;
  #enqueuedEvents = 0;
  #writeBatches = 0;

  constructor(
    private readonly write: (runtimeId: string, data: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(runtimeId: string, data: string): void {
    if (!data) return;
    this.#enqueuedEvents += 1;
    const tail = this.#pending.at(-1);
    if (tail?.runtimeId === runtimeId) {
      tail.data += data;
      tail.events += 1;
    } else {
      this.#pending.push({ runtimeId, data, events: 1 });
    }
    this.#pump();
  }

  drain(): Promise<void> {
    if (!this.#writeInFlight && this.#pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  snapshot(): TerminalInputWriterSnapshot {
    return {
      enqueuedEvents: this.#enqueuedEvents,
      writeBatches: this.#writeBatches,
      pendingEvents: this.#pending.reduce(
        (total, input) => total + input.events,
        0,
      ),
      pendingCodeUnits: this.#pending.reduce(
        (total, input) => total + input.data.length,
        0,
      ),
      writeInFlight: this.#writeInFlight,
    };
  }

  #pump(): void {
    if (this.#writeInFlight) return;
    const input = this.#pending.shift();
    if (!input) {
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
      return;
    }
    this.#writeInFlight = true;
    this.#writeBatches += 1;
    let result: Promise<void>;
    try {
      result = this.write(input.runtimeId, input.data);
    } catch (error) {
      this.#finishWrite(true, error);
      return;
    }
    void result.then(
      () => this.#finishWrite(false),
      (error) => this.#finishWrite(true, error),
    );
  }

  #finishWrite(failed: boolean, error?: unknown): void {
    this.#writeInFlight = false;
    try {
      if (failed) this.onError(error);
    } finally {
      this.#pump();
    }
  }
}
