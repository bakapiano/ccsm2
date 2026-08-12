/**
 * Claude Code-specific resize repair.
 *
 * Claude renders primary-buffer history with absolute cursor positioning and
 * only repaints its current viewport on a normal resize. These helpers must
 * not be applied to Shell or Codex terminals.
 */

const ESC = 0x1b;
const HOME = new Uint8Array([ESC, 0x5b, 0x48]);
const ERASE_LINE = new Uint8Array([ESC, 0x5b, 0x32, 0x4b]);
const CRLF = new Uint8Array([0x0d, 0x0a]);
export const SYNCHRONIZED_UPDATE_END = new Uint8Array([
  ESC,
  0x5b,
  0x3f,
  0x32,
  0x30,
  0x32,
  0x36,
  0x6c,
]);

export const MAX_CLAUDE_REPAINT_ROWS = 2_048;
export const MAX_CLAUDE_REPAINT_BYTES = 8 * 1024 * 1024;

export interface ClaudeHistoryRepaintEligibility {
  provider: string | null;
  nativeBindingState: string | null;
  hasNativeSessionId: boolean;
  runtimeMatches: boolean;
  previousCols: number | null;
  nextCols: number;
  scrollbackLength: number;
  alternateScreen: boolean;
  captureActive: boolean;
}

export function shouldRunClaudeHistoryRepaint(
  state: ClaudeHistoryRepaintEligibility,
): boolean {
  return (
    state.provider === "claude" &&
    state.nativeBindingState === "bound" &&
    state.hasNativeSessionId &&
    state.runtimeMatches &&
    state.previousCols !== null &&
    state.nextCols !== state.previousCols &&
    state.scrollbackLength > 0 &&
    !state.alternateScreen &&
    !state.captureActive
  );
}

export function calculateClaudeRepaintRows(
  scrollbackLines: number,
  visibleRows: number,
): number | null {
  if (scrollbackLines < 1 || visibleRows < 1) return null;
  const estimatedFullRenderRows = (scrollbackLines + visibleRows) * 2 + 64;
  if (estimatedFullRenderRows > MAX_CLAUDE_REPAINT_ROWS) return null;
  return Math.max(visibleRows + 64, estimatedFullRenderRows);
}

export function calculateRepaintViewportY(
  previousViewportY: number,
  previousScrollbackLength: number,
  nextScrollbackLength: number,
): number {
  if (
    previousViewportY <= 0 ||
    previousScrollbackLength <= 0 ||
    nextScrollbackLength <= 0
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      nextScrollbackLength,
      Math.round(
        previousViewportY * (nextScrollbackLength / previousScrollbackLength),
      ),
    ),
  );
}

export function extractClaudeFullRepaint(
  chunks: readonly Uint8Array[],
  expandedRows: number,
): Uint8Array | null {
  const bytes = mergeByteChunks(chunks);
  if (!bytes || bytes.byteLength > MAX_CLAUDE_REPAINT_BYTES) return null;

  let clearStart = findSequence(bytes, HOME, 0);
  if (clearStart > 64) return null;
  while (clearStart >= 0) {
    const repaintStart = findSequence(bytes, HOME, clearStart + HOME.length);
    if (repaintStart < 0) return null;
    const erasedRows = countSequence(
      bytes,
      ERASE_LINE,
      clearStart + HOME.length,
      repaintStart,
    );
    if (erasedRows >= expandedRows) {
      const repaint = bytes.slice(repaintStart);
      if (
        countSequence(repaint, CRLF, 0, repaint.length) >= 10 &&
        includesAscii(repaint, "Welcome") &&
        includesAscii(repaint, "back!")
      ) {
        return repaint;
      }
    }
    clearStart = repaintStart;
  }
  return null;
}

export function extractClaudeSynchronizedRepaint(
  chunks: readonly Uint8Array[],
  expandedRows: number,
): Uint8Array | null {
  const repaint = extractClaudeFullRepaint(chunks, expandedRows);
  if (!repaint || findSequence(repaint, SYNCHRONIZED_UPDATE_END, 0) < 0) {
    return null;
  }
  return repaint;
}

export function extractClaudeCursorPositionedRepaint(
  chunks: readonly Uint8Array[],
  expandedRows: number,
): Uint8Array | null {
  const repaint = extractClaudeFullRepaint(chunks, expandedRows);
  if (
    !repaint ||
    !includesAscii(repaint, "shift+tab") ||
    !endsWithCursorPlacement(repaint)
  ) {
    return null;
  }
  return repaint;
}

export class ChunkedByteSequenceMatcher {
  #matched = 0;

  constructor(private readonly sequence: Uint8Array) {
    if (sequence.byteLength === 0) {
      throw new Error("byte sequence must not be empty");
    }
  }

  push(bytes: Uint8Array): boolean {
    let complete = false;
    for (const byte of bytes) {
      if (byte === this.sequence[this.#matched]) {
        this.#matched += 1;
        if (this.#matched === this.sequence.byteLength) {
          complete = true;
          this.#matched = 0;
        }
        continue;
      }
      this.#matched = byte === this.sequence[0] ? 1 : 0;
    }
    return complete;
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ResizeOutputSettleResult {
  completion: "synchronized" | "quiet" | "timeout" | "cancelled";
  sawOutput: boolean;
}

export class ResizeOutputSettler {
  readonly result: Promise<ResizeOutputSettleResult>;
  #resolve!: (result: ResizeOutputSettleResult) => void;
  #quietTimer: TimerHandle | null = null;
  #timeoutTimer: TimerHandle | null = null;
  #settled = false;
  #sawOutput = false;
  #lastOutputEndedSynchronized = false;
  readonly #synchronizedEnd = new ChunkedByteSequenceMatcher(
    SYNCHRONIZED_UPDATE_END,
  );

  constructor(
    readonly runtimeId: string,
    private readonly quietMs: number,
    timeoutMs: number,
    private readonly setTimer: (
      callback: () => void,
      delayMs: number,
    ) => TimerHandle = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly clearTimer: (handle: TimerHandle) => void = (handle) =>
      clearTimeout(handle),
  ) {
    this.result = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    this.#timeoutTimer = this.setTimer(
      () => this.#finish("timeout"),
      timeoutMs,
    );
  }

  startGracePeriod(): void {
    if (!this.#settled && this.#quietTimer === null) this.#armQuietTimer();
  }

  push(runtimeId: string, bytes: Uint8Array): boolean {
    if (this.#settled || runtimeId !== this.runtimeId) return false;
    this.#sawOutput = true;
    this.#lastOutputEndedSynchronized = this.#synchronizedEnd.push(bytes);
    this.#armQuietTimer();
    return true;
  }

  cancel(): void {
    this.#finish("cancelled");
  }

  #armQuietTimer(): void {
    if (this.#quietTimer !== null) this.clearTimer(this.#quietTimer);
    this.#quietTimer = this.setTimer(
      () =>
        this.#finish(
          this.#lastOutputEndedSynchronized ? "synchronized" : "quiet",
        ),
      this.quietMs,
    );
  }

  #finish(completion: ResizeOutputSettleResult["completion"]): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#quietTimer !== null) this.clearTimer(this.#quietTimer);
    if (this.#timeoutTimer !== null) this.clearTimer(this.#timeoutTimer);
    this.#quietTimer = null;
    this.#timeoutTimer = null;
    this.#resolve({ completion, sawOutput: this.#sawOutput });
  }
}

function mergeByteChunks(chunks: readonly Uint8Array[]): Uint8Array | null {
  if (chunks.length === 0) return null;
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (length > MAX_CLAUDE_REPAINT_BYTES) return null;
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function findSequence(
  bytes: Uint8Array,
  sequence: Uint8Array,
  fromIndex: number,
): number {
  outer: for (
    let index = Math.max(0, fromIndex);
    index <= bytes.length - sequence.length;
    index += 1
  ) {
    for (
      let sequenceIndex = 0;
      sequenceIndex < sequence.length;
      sequenceIndex += 1
    ) {
      if (bytes[index + sequenceIndex] !== sequence[sequenceIndex]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

function countSequence(
  bytes: Uint8Array,
  sequence: Uint8Array,
  fromIndex: number,
  toIndex: number,
): number {
  let count = 0;
  let index = findSequence(bytes, sequence, fromIndex);
  while (index >= 0 && index < toIndex) {
    count += 1;
    index = findSequence(bytes, sequence, index + sequence.length);
  }
  return count;
}

function includesAscii(bytes: Uint8Array, text: string): boolean {
  return findSequence(bytes, new TextEncoder().encode(text), 0) >= 0;
}

function endsWithCursorPlacement(bytes: Uint8Array): boolean {
  const cursorUpStart = findCsiNumberCommandStart(
    bytes,
    bytes.length - 1,
    0x41,
  );
  if (cursorUpStart < 0) return false;
  return findCsiNumberCommandStart(bytes, cursorUpStart - 1, 0x43) >= 0;
}

function findCsiNumberCommandStart(
  bytes: Uint8Array,
  commandIndex: number,
  command: number,
): number {
  if (commandIndex < 3 || bytes[commandIndex] !== command) return -1;
  let index = commandIndex - 1;
  let hasDigit = false;
  while (index >= 0 && bytes[index] >= 0x30 && bytes[index] <= 0x39) {
    hasDigit = true;
    index -= 1;
  }
  if (
    !hasDigit ||
    index < 1 ||
    bytes[index] !== 0x5b ||
    bytes[index - 1] !== ESC
  ) {
    return -1;
  }
  return index - 1;
}
