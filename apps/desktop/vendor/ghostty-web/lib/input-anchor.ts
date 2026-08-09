export interface InputAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InputAnchorMetrics {
  width: number;
  height: number;
}

export interface InputAnchorPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Resolve the CSS box used by the hidden textarea that anchors the platform
 * IME. The scale factors keep it aligned even if CSS scales the canvas.
 */
export function calculateInputAnchor(
  canvasRect: InputAnchorRect,
  cursorX: number,
  cursorY: number,
  cols: number,
  rows: number,
  metrics: InputAnchorMetrics,
): InputAnchorPosition {
  const logicalWidth = Math.max(1, cols * metrics.width);
  const logicalHeight = Math.max(1, rows * metrics.height);
  const scaleX = canvasRect.width > 0 ? canvasRect.width / logicalWidth : 1;
  const scaleY = canvasRect.height > 0 ? canvasRect.height / logicalHeight : 1;
  const col = Math.max(0, Math.min(cursorX, Math.max(0, cols - 1)));
  const row = Math.max(0, Math.min(cursorY, Math.max(0, rows - 1)));

  return {
    left: canvasRect.left + col * metrics.width * scaleX,
    top: canvasRect.top + row * metrics.height * scaleY,
    width: Math.max(1, metrics.width * scaleX),
    height: Math.max(1, metrics.height * scaleY),
  };
}
