import { isDynamicColorQuerySequence } from "../vendor/ghostty-web/lib/dynamic-color-query";

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

export function stripOscSequences(buffer: Uint8Array): Uint8Array {
  return new OscSequenceStripper().push(buffer);
}

export class OscSequenceStripper {
  #inOsc = false;
  #inCsi = false;
  #pendingEsc = false;
  #csiBytes: number[] = [];
  #oscBytes: number[] | null = null;

  private readonly preserveDynamicColorQueries: boolean;

  constructor(options: { preserveDynamicColorQueries?: boolean } = {}) {
    this.preserveDynamicColorQueries =
      options.preserveDynamicColorQueries ?? false;
  }

  push(buffer: Uint8Array): Uint8Array {
    const output: number[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const byte = buffer[index];
      if (this.#inCsi) {
        this.#csiBytes.push(byte);
        if (byte >= 0x40 && byte <= 0x7e) {
          const shouldDrop = shouldDropCsi(this.#csiBytes);
          if (!shouldDrop) output.push(0x1b, 0x5b, ...this.#csiBytes);
          this.#csiBytes = [];
          this.#inCsi = false;
        }
        continue;
      }
      if (this.#inOsc) {
        this.#trackOscByte(byte);
        if (this.#pendingEsc) {
          this.#pendingEsc = false;
          if (byte === 0x5c) {
            this.#finishOsc(output);
            continue;
          }
        }
        if (byte === 0x07) {
          this.#finishOsc(output);
          continue;
        }
        if (byte === 0x1b) {
          this.#pendingEsc = true;
          continue;
        }
        continue;
      }
      if (this.#pendingEsc) {
        this.#pendingEsc = false;
        if (byte === 0x5d) {
          this.#inOsc = true;
          this.#oscBytes = this.preserveDynamicColorQueries
            ? [0x1b, 0x5d]
            : null;
          continue;
        }
        if (byte === 0x5b) {
          this.#inCsi = true;
          this.#csiBytes = [];
          continue;
        }
        output.push(0x1b, byte);
        continue;
      }
      if (byte === 0x1b) {
        this.#pendingEsc = true;
        continue;
      }
      output.push(byte);
    }
    return new Uint8Array(output);
  }

  #trackOscByte(byte: number): void {
    if (!this.#oscBytes) return;
    this.#oscBytes.push(byte);
    if (this.#oscBytes.length > 16) this.#oscBytes = null;
  }

  #finishOsc(output: number[]): void {
    if (this.#oscBytes && isDynamicColorQuerySequence(this.#oscBytes)) {
      output.push(...this.#oscBytes);
    }
    this.#oscBytes = null;
    this.#inOsc = false;
    this.#pendingEsc = false;
  }

  flush(): Uint8Array {
    if (this.#inCsi) {
      const output = new Uint8Array([0x1b, 0x5b, ...this.#csiBytes]);
      this.#inCsi = false;
      this.#csiBytes = [];
      return output;
    }
    if (!this.#pendingEsc || this.#inOsc) return new Uint8Array();
    this.#pendingEsc = false;
    return new Uint8Array([0x1b]);
  }
}

function shouldDropCsi(bytes: readonly number[]): boolean {
  const final = bytes.at(-1);
  if (final === 0x74) return true;
  const body = String.fromCharCode(...bytes);
  return body.includes("9001");
}

export function stripOscSequencesStateless(buffer: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x1b && buffer[index + 1] === 0x5d) {
      index += 2;
      while (index < buffer.length) {
        if (buffer[index] === 0x07) break;
        if (buffer[index] === 0x1b && buffer[index + 1] === 0x5c) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    output.push(buffer[index]);
  }
  return new Uint8Array(output);
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
