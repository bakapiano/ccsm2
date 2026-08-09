export const TERMINAL_SCROLLBAR_WIDTH = 8;

export interface ScrollbarGeometry {
  thumbHeight: number;
  thumbTop: number;
  movableHeight: number;
}

export function calculateScrollbarGeometry(
  trackHeight: number,
  scrollbackLength: number,
  visibleRows: number,
  viewportY: number,
): ScrollbarGeometry {
  const totalLines = Math.max(1, scrollbackLength + visibleRows);
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(20, (visibleRows / totalLines) * trackHeight),
  );
  const movableHeight = Math.max(0, trackHeight - thumbHeight);
  const scrollPosition =
    scrollbackLength > 0
      ? Math.max(0, Math.min(1, viewportY / scrollbackLength))
      : 0;
  return {
    thumbHeight,
    thumbTop: movableHeight * (1 - scrollPosition),
    movableHeight,
  };
}
