export interface WrappedBufferCell {
  getCodepoint(): number;
  getWidth?(): number;
}

export interface WrappedBufferLine {
  readonly length: number;
  /** True when this physical row continues the preceding row. */
  readonly isWrapped?: boolean;
  getCell(x: number): WrappedBufferCell | undefined;
}

export interface WrappedLineBuffer {
  getLine(y: number): WrappedBufferLine | undefined;
}

export interface BufferCellPosition {
  x: number;
  y: number;
}

export interface ExtractedWrappedLine {
  text: string;
  positions: BufferCellPosition[];
  startY: number;
  endY: number;
}

/**
 * Reconstruct one logical terminal line from its soft-wrapped physical rows.
 * `positions` maps every UTF-16 code unit in `text` back to a buffer cell.
 */
export function extractWrappedLine(
  buffer: WrappedLineBuffer,
  y: number,
): ExtractedWrappedLine | null {
  let firstLine = buffer.getLine(y);
  if (!firstLine) return null;

  let startY = y;
  while (startY > 0 && firstLine.isWrapped) {
    const previousLine = buffer.getLine(startY - 1);
    if (!previousLine) break;
    firstLine = previousLine;
    startY -= 1;
  }

  let text = "";
  const positions: BufferCellPosition[] = [];
  let endY = startY;

  for (let row = startY; ; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;

    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      const width = cell?.getWidth?.() ?? 1;
      if (width === 0) continue;

      const codepoint = cell?.getCodepoint() ?? 0;
      const character = codepoint >= 32 ? String.fromCodePoint(codepoint) : " ";
      text += character;
      for (let index = 0; index < character.length; index += 1) {
        positions.push({ x, y: row });
      }
    }

    endY = row;
    const nextLine = buffer.getLine(row + 1);
    if (!nextLine?.isWrapped) break;
  }

  return { text, positions, startY, endY };
}
