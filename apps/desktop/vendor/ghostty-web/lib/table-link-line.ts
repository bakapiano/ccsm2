import {
  extractWrappedLine,
  type ExtractedWrappedLine,
  type WrappedLineBuffer,
} from "./wrapped-buffer-line";

const MAX_TABLE_ROWS = 32;
const NEW_TARGET =
  /^(?:["'`(])?(?:(?:https?|ftp|file):\/\/|[A-Za-z]:[\\/]|\.{1,2}[\\/])/u;
const CLOSED_TARGET = /[)\]}>"'`]$/u;

/** Recover borderless Markdown table cells using the divider's column layout. */
export function extractTableLinkLines(
  buffer: WrappedLineBuffer,
  y: number,
): ExtractedWrappedLine[] {
  const current = extractWrappedLine(buffer, y);
  if (!current) return [];
  let header: ExtractedWrappedLine | null = current;
  let columns: number[] = [];
  while (header && header.startY >= y - MAX_TABLE_ROWS) {
    if (!header.text.trim()) return [];
    columns = dividerColumns(header, buffer);
    if (columns.length >= 2) break;
    header =
      header.startY > 0 ? extractWrappedLine(buffer, header.startY - 1) : null;
  }
  if (!header || columns.length < 2) return [];

  const result: ExtractedWrappedLine[] = [];
  const cells: Array<ExtractedWrappedLine | undefined> = [];
  const flush = (column: number) => {
    const cell = cells[column];
    if (cell && cell.startY < cell.endY && cell.startY <= y && cell.endY >= y)
      result.push(cell);
    cells[column] = undefined;
  };
  for (let row = header.endY + 1; row <= header.endY + MAX_TABLE_ROWS; ) {
    const line = extractWrappedLine(buffer, row);
    if (!line || !line.text.trim()) break;
    if (dividerColumns(line, buffer).length >= 2) break;
    const prefix = columnText(line, buffer, 0, columns[0]);
    if (prefix.text) break;
    const parts = columns.map((start, index) =>
      columnText(line, buffer, start, columns[index + 1] ?? Infinity),
    );
    for (let column = 1; column < columns.length; column += 1) {
      const part = parts[column];
      const previous = cells[column];
      // A populated label column begins another table row. Empty cells,
      // explicit closing delimiters and fresh targets also end a link span.
      if (
        parts.slice(0, column).some((value) => value.text) ||
        !part.text ||
        (previous &&
          (CLOSED_TARGET.test(previous.text) || NEW_TARGET.test(part.text)))
      )
        flush(column);
      if (!part.text) continue;
      const cell = cells[column];
      if (cell) {
        cell.text += part.text;
        cell.positions.push(...part.positions);
        cell.endY = part.endY;
      } else cells[column] = part;
    }
    row = line.endY + 1;
  }
  for (let column = 1; column < columns.length; column += 1) flush(column);
  return result;
}

function dividerColumns(
  line: ExtractedWrappedLine,
  buffer: WrappedLineBuffer,
): number[] {
  if (!/^\s*[-─━]{3,}(?:\s+[-─━]{3,})+\s*$/u.test(line.text)) return [];
  return [...line.text.matchAll(/[-─━]{3,}/gu)].map((match) =>
    virtualColumn(line, buffer, match.index),
  );
}

function virtualColumn(
  line: ExtractedWrappedLine,
  buffer: WrappedLineBuffer,
  index: number,
): number {
  const position = line.positions[index];
  return (
    (position.y - line.startY) * (buffer.getLine(line.startY)?.length ?? 0) +
    position.x
  );
}

function columnText(
  line: ExtractedWrappedLine,
  buffer: WrappedLineBuffer,
  start: number,
  end: number,
): ExtractedWrappedLine {
  let from = line.positions.findIndex(
    (_, index) => virtualColumn(line, buffer, index) >= start,
  );
  if (from < 0) from = line.text.length;
  let to = from;
  while (to < line.text.length && virtualColumn(line, buffer, to) < end)
    to += 1;
  while (from < to && /\s/u.test(line.text[from])) from += 1;
  while (to > from && /\s/u.test(line.text[to - 1])) to -= 1;
  const positions = line.positions.slice(from, to);
  return {
    text: line.text.slice(from, to),
    positions,
    startY: positions[0]?.y ?? line.startY,
    endY: positions.at(-1)?.y ?? line.endY,
  };
}
