/** Pure pointer hit-testing helpers shared by SelectionManager and tests. */

export function crossedDragThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
  cellWidth: number,
): boolean {
  const dx = x - startX;
  const dy = y - startY;
  const threshold = Math.max(2, Math.min(5, cellWidth * 0.35));
  return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * Stabilize a drag endpoint around a horizontal cell boundary.
 *
 * Moving into the next row switches at that row's centre. Moving back uses
 * the opposite centre, forming a Schmitt trigger that cannot chatter while
 * the pointer is sitting in the visual gap between two lines.
 */
export function resolveDragRow(
  rawRow: number,
  previousRow: number | null,
  y: number,
  cellHeight: number,
): number {
  if (previousRow === null || rawRow === previousRow) return rawRow;

  const hysteresis = cellHeight * 0.5;
  if (rawRow === previousRow + 1) {
    const boundaryY = (previousRow + 1) * cellHeight;
    if (y < boundaryY + hysteresis) return previousRow;
  } else if (rawRow === previousRow - 1) {
    const boundaryY = previousRow * cellHeight;
    if (y > boundaryY - hysteresis) return previousRow;
  }

  return rawRow;
}
