export class LatestValue<T> {
  #value: T | undefined;

  set(value: T): void {
    this.#value = value;
  }

  take(): T | undefined {
    const value = this.#value;
    this.#value = undefined;
    return value;
  }

  clear(): void {
    this.#value = undefined;
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class DebouncedTask {
  #timer: TimerHandle | undefined;

  constructor(
    readonly delayMs: number,
    private readonly setTimer: (
      callback: () => void,
      delayMs: number,
    ) => TimerHandle = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly clearTimer: (handle: TimerHandle) => void = (handle) =>
      clearTimeout(handle),
  ) {}

  schedule(task: () => void): void {
    this.cancel();
    this.#timer = this.setTimer(() => {
      this.#timer = undefined;
      task();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.#timer === undefined) return;
    this.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  get pending(): boolean {
    return this.#timer !== undefined;
  }
}

export class TailByteBuffer {
  #chunks: Uint8Array[] = [];
  #length = 0;
  #omitted = 0;

  constructor(readonly limitBytes: number) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.limitBytes) {
      this.#omitted += this.#length + chunk.byteLength - this.limitBytes;
      this.#chunks = [chunk.slice(chunk.byteLength - this.limitBytes)];
      this.#length = this.limitBytes;
      return;
    }
    this.#chunks.push(chunk);
    this.#length += chunk.byteLength;
    while (this.#length > this.limitBytes) {
      const first = this.#chunks[0];
      const overflow = this.#length - this.limitBytes;
      if (!first) break;
      if (first.byteLength <= overflow) {
        this.#chunks.shift();
        this.#length -= first.byteLength;
        this.#omitted += first.byteLength;
      } else {
        this.#chunks[0] = first.slice(overflow);
        this.#length -= overflow;
        this.#omitted += overflow;
      }
    }
  }

  take(): Uint8Array | undefined {
    const output = mergeChunks(this.#chunks, this.#length);
    this.#chunks = [];
    this.#length = 0;
    return output;
  }

  get omittedBytes(): number {
    return this.#omitted;
  }

  get length(): number {
    return this.#length;
  }
}

export function takeByteBatch(
  queue: Uint8Array[],
  budget: number,
): Uint8Array | undefined {
  if (queue.length === 0) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (queue.length > 0 && (length < budget || chunks.length === 0)) {
    const chunk = queue.shift()!;
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  return mergeChunks(chunks, length);
}

function mergeChunks(
  chunks: readonly Uint8Array[],
  length: number,
): Uint8Array | undefined {
  if (chunks.length === 0) return undefined;
  if (chunks.length === 1 && chunks[0].byteLength === length) return chunks[0];
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function runtimeStartCanCommit(
  exitedRuntimeIds: ReadonlySet<string>,
  runtimeId: string,
): boolean {
  return !exitedRuntimeIds.has(runtimeId);
}

export interface CliAutoStartState {
  desiredState: "running" | "stopped";
  nativeBindingState: "not_applicable" | "pending" | "bound" | "unavailable";
}

export function shouldAutoStartCliRuntime(
  session: CliAutoStartState,
  activeVisible: boolean,
  manualStopBlocked: boolean,
): boolean {
  if (session.nativeBindingState === "unavailable") return false;
  if (!activeVisible) return false;
  if (session.desiredState === "running") return true;
  return session.nativeBindingState === "bound" && !manualStopBlocked;
}
