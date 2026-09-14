import type { IBufferRange } from "./types";
import {
  extractWrappedLine,
  type BufferCellPosition,
  type ExtractedWrappedLine,
  type WrappedLineBuffer,
} from "./wrapped-buffer-line";

const MAX_CONTINUATION_ROWS = 32;
const LINK_START =
  /^(?:["'`])?(?:(?:https?|ftp|file):\/\/|[A-Za-z]:[\\/]|\.{0,2}[\\/]|[\p{L}\p{N}_.@+-]+[\\/])/u;
const NEW_TARGET = /^(?:(?:https?|ftp|file):\/\/|[A-Za-z]:[\\/]|\.{0,2}[\\/])/u;
const FILE_END = /\.[\p{L}\p{N}_-]{1,16}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/u;

interface StyledRun extends ExtractedWrappedLine {
  style: string;
  closed: boolean;
  columnStart: number;
  styled: boolean;
}

/**
 * TUI Markdown renderers also wrap inside styled spans using hard newlines.
 * Reassemble those spans in their own column, ahead of plain soft-wrap parsing.
 * The cell map preserves indentation and table gaps as non-clickable space.
 */
export function extractRenderedLinkLines(
  buffer: WrappedLineBuffer,
  y: number,
): ExtractedWrappedLine[] {
  const result: ExtractedWrappedLine[] = [];
  const foreground = buffer.getDefaultFgColor?.();
  if (foreground !== undefined) {
    const rows = new Map<number, StyledRun[]>();
    const read = (row: number) => {
      let runs = rows.get(row);
      if (!runs) {
        runs = styledRuns(buffer, row, foreground);
        rows.set(row, runs);
      }
      return runs;
    };

    for (let row = Math.max(0, y - MAX_CONTINUATION_ROWS); row <= y; row += 1) {
      for (const first of read(row)) {
        if (!LINK_START.test(first.text)) continue;
        let last = first;
        let text = first.text;
        const positions = [...first.positions];
        const web = /^["'`]?(?:https?|ftp|file):\/\//u.test(text);
        for (
          let nextY = row + 1;
          nextY <= row + MAX_CONTINUATION_ROWS;
          nextY += 1
        ) {
          if (
            last.closed ||
            (!web && FILE_END.test(text) && !atRightEdge(buffer, last))
          )
            break;
          const candidates = read(nextY).filter(
            (next) =>
              next.style === last.style &&
              ((next.positions[0].x === 0 && atRightEdge(buffer, last)) ||
                (last.styled &&
                  next.styled &&
                  next.positions[0].x >= first.columnStart &&
                  next.positions[0].x <= last.positions[0].x)) &&
              (!NEW_TARGET.test(next.text) ||
                (next.positions[0].x === 0 &&
                  atRightEdge(buffer, last) &&
                  /^[\\/]/u.test(next.text))),
          );
          if (candidates.length !== 1) break;
          last = candidates[0];
          text += last.text;
          positions.push(...last.positions);
        }
        if (last.startY > first.startY && last.startY >= y) {
          result.push({ text, positions, startY: row, endY: last.startY });
        }
      }
    }
  }

  const wrapped = extractWrappedLine(buffer, y);
  if (wrapped) result.push(wrapped);
  return result;
}

/** Coalesce physically contiguous cells; indentation and table gaps stay out. */
export function linkRanges(
  buffer: WrappedLineBuffer,
  positions: BufferCellPosition[],
  startIndex: number,
  endIndex: number,
): IBufferRange[] {
  const ranges: IBufferRange[] = [];
  for (const position of positions.slice(startIndex, endIndex)) {
    const previous = ranges.at(-1);
    if (
      previous &&
      (previous.end.y === position.y ||
        (previous.end.y + 1 === position.y &&
          position.x === 0 &&
          previous.end.x === (buffer.getLine(previous.end.y)?.length ?? 0) - 1))
    )
      previous.end = position;
    else ranges.push({ start: position, end: position });
  }
  return ranges;
}

function styledRuns(
  buffer: WrappedLineBuffer,
  y: number,
  foreground: number,
): StyledRun[] {
  const line = buffer.getLine(y);
  if (!line) return [];
  const runs: StyledRun[] = [];
  let current: StyledRun | undefined;
  let columnStart = 0;
  let spaces = 0;
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (cell?.getWidth?.() === 0) continue;
    const codepoint = cell?.getCodepoint() ?? 0;
    if (codepoint <= 32) spaces += 1;
    else {
      if (spaces >= 2) columnStart = x;
      spaces = 0;
    }
    const color = cell?.getFgColor?.();
    const underline = cell?.isUnderline?.() ?? 0;
    if (codepoint <= 32 || color === undefined) {
      if (current && codepoint > 32) current.closed = true;
      current = undefined;
      continue;
    }
    const style = `${color}:${Number(underline)}`;
    if (!current || current.style !== style) {
      if (current) current.closed = true;
      current = {
        text: "",
        positions: [],
        startY: y,
        endY: y,
        style,
        closed: false,
        columnStart,
        styled: color !== foreground || Boolean(underline),
      };
      runs.push(current);
    }
    const character = String.fromCodePoint(codepoint);
    current.text += character;
    for (let index = 0; index < character.length; index += 1)
      current.positions.push({ x, y });
  }
  return runs.filter((run) => {
    if (/[)\]}>"'`]$/u.test(run.text)) run.closed = true;
    if (run.style !== `${foreground}:0`) return true;
    // ConPTY/TUI row repaint can replace a soft-wrap with an explicit CRLF.
    // Recover plain tokens only at a full-width row edge and column-zero tail.
    if (atRightEdge(buffer, run)) return true;
    if (run.positions[0].x !== 0 || y === 0) return false;
    const previous = buffer.getLine(y - 1);
    return Boolean(
      previous &&
        (previous.getCell(previous.length - 1)?.getCodepoint() ?? 0) > 32,
    );
  });
}

function atRightEdge(buffer: WrappedLineBuffer, run: StyledRun): boolean {
  return (
    run.positions.at(-1)?.x === (buffer.getLine(run.endY)?.length ?? 0) - 1
  );
}
