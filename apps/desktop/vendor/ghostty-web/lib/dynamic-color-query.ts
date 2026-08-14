import type { ITheme } from "./interfaces";
import { DEFAULT_THEME } from "./renderer";

const ESC = 0x1b;
const OSC = 0x5d;
const BEL = 0x07;
const ST = 0x5c;
const MAX_OSC_SEQUENCE_BYTES = 4_096;

export interface DynamicColorQueryResult {
  output: Uint8Array;
  responses: string[];
}

/**
 * Handles xterm dynamic-color queries before they reach ghostty-vt.
 *
 * The current WASM build cannot allocate OSC 10/11/12 query responses, so
 * agent CLIs otherwise time out and assume a dark terminal. The handler is
 * streaming because PTY chunks may split an OSC sequence at any byte.
 */
export class DynamicColorQueryHandler {
  #pending: number[] = [];

  push(input: string | Uint8Array, theme: ITheme): DynamicColorQueryResult {
    const bytes =
      typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (this.#pending.length === 0 && !containsPotentialOsc(bytes)) {
      return { output: bytes, responses: [] };
    }
    const output: number[] = [];
    const responses: string[] = [];

    for (const byte of bytes) {
      if (this.#pending.length === 0) {
        if (byte === ESC) this.#pending.push(byte);
        else output.push(byte);
        continue;
      }

      if (this.#pending.length === 1) {
        if (byte === OSC) {
          this.#pending.push(byte);
          continue;
        }

        output.push(ESC);
        this.#pending = [];
        if (byte === ESC) this.#pending.push(byte);
        else output.push(byte);
        continue;
      }

      this.#pending.push(byte);
      const terminatedByBel = byte === BEL;
      const terminatedBySt = byte === ST && this.#pending.at(-2) === ESC;
      if (terminatedByBel || terminatedBySt) {
        this.#finishSequence(output, responses, theme, terminatedByBel ? 1 : 2);
      } else if (this.#pending.length > MAX_OSC_SEQUENCE_BYTES) {
        output.push(...this.#pending);
        this.#pending = [];
      }
    }

    return { output: new Uint8Array(output), responses };
  }

  reset(): void {
    this.#pending = [];
  }

  #finishSequence(
    output: number[],
    responses: string[],
    theme: ITheme,
    terminatorLength: 1 | 2,
  ): void {
    const sequence = this.#pending;
    this.#pending = [];
    const body = String.fromCharCode(
      ...sequence.slice(2, sequence.length - terminatorLength),
    );
    const match = /^(10|11|12);\?$/.exec(body);
    if (!match) {
      output.push(...sequence);
      return;
    }

    const code = Number(match[1]) as 10 | 11 | 12;
    const resolvedTheme = { ...DEFAULT_THEME, ...theme };
    const color =
      code === 10
        ? resolvedTheme.foreground
        : code === 11
          ? resolvedTheme.background
          : resolvedTheme.cursor;
    const rgb = toXtermRgb(color);
    const terminator = terminatorLength === 1 ? "\x07" : "\x1b\\";
    responses.push(`\x1b]${code};${rgb}${terminator}`);
  }
}

function containsPotentialOsc(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== ESC) continue;
    if (index === bytes.length - 1 || bytes[index + 1] === OSC) return true;
  }
  return false;
}

export function isDynamicColorQuerySequence(
  sequence: readonly number[],
): boolean {
  if (sequence[0] !== ESC || sequence[1] !== OSC) return false;
  const terminatedByBel = sequence.at(-1) === BEL;
  const terminatedBySt = sequence.at(-2) === ESC && sequence.at(-1) === ST;
  if (!terminatedByBel && !terminatedBySt) return false;
  const terminatorLength = terminatedByBel ? 1 : 2;
  const body = String.fromCharCode(
    ...sequence.slice(2, sequence.length - terminatorLength),
  );
  return /^(10|11|12);\?$/.test(body);
}

function toXtermRgb(color: string): string {
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const longHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const rgb = longHex?.slice(1) ??
    shortHex?.slice(1).map((component) => component.repeat(2)) ?? [
      "00",
      "00",
      "00",
    ];
  return `rgb:${rgb.map((component) => component.repeat(2)).join("/")}`;
}
