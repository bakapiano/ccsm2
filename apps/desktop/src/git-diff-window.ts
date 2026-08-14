export interface GitDiffVirtualWindow {
  start: number;
  end: number;
  paddingBefore: number;
  paddingAfter: number;
}

export const GIT_DIFF_ROW_HEIGHT = 20;
export const GIT_DIFF_OVERSCAN_ROWS = 32;

export function gitDiffVirtualWindow(
  rowCount: number,
  viewportStart: number,
  viewportEnd: number,
  rowHeight = GIT_DIFF_ROW_HEIGHT,
  overscanRows = GIT_DIFF_OVERSCAN_ROWS,
): GitDiffVirtualWindow {
  const totalRows = Math.max(0, Math.floor(rowCount));
  const resolvedRowHeight = Math.max(1, rowHeight);
  const totalHeight = totalRows * resolvedRowHeight;
  if (
    totalRows === 0 ||
    viewportEnd <= 0 ||
    viewportStart >= totalHeight ||
    viewportEnd <= viewportStart
  ) {
    return {
      start: 0,
      end: 0,
      paddingBefore: 0,
      paddingAfter: totalHeight,
    };
  }

  const overscan = Math.max(0, Math.floor(overscanRows));
  const start = Math.max(
    0,
    Math.floor(Math.max(0, viewportStart) / resolvedRowHeight) - overscan,
  );
  const end = Math.min(
    totalRows,
    Math.ceil(Math.min(totalHeight, viewportEnd) / resolvedRowHeight) +
      overscan,
  );
  return {
    start,
    end,
    paddingBefore: start * resolvedRowHeight,
    paddingAfter: (totalRows - end) * resolvedRowHeight,
  };
}
