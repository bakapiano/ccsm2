export interface ListWindow {
  start: number;
  end: number;
  paddingBefore: number;
  paddingAfter: number;
}

export function listWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscanRows = 20,
): ListWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const height = Math.max(1, rowHeight);
  const overscan = Math.max(0, Math.floor(overscanRows));
  const start = Math.max(0, Math.floor(scrollTop / height) - overscan);
  const end = Math.min(
    count,
    Math.ceil((scrollTop + Math.max(0, viewportHeight)) / height) + overscan,
  );
  return {
    start,
    end,
    paddingBefore: start * height,
    paddingAfter: (count - end) * height,
  };
}
