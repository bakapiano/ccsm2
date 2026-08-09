export interface LayoutSize {
  width: number;
  height: number;
}

export interface LayoutRect extends LayoutSize {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function isDockGeometrySettled(
  apiSize: LayoutSize,
  groupRect: LayoutRect,
  panelRect: LayoutRect,
): boolean {
  if (apiSize.width < 1 || apiSize.height < 1) return false;
  const tolerance = 1;
  return (
    Math.abs(groupRect.width - apiSize.width) <= tolerance &&
    Math.abs(groupRect.height - apiSize.height) <= tolerance &&
    Math.abs(panelRect.width - groupRect.width) <= tolerance &&
    Math.abs(panelRect.right - groupRect.right) <= tolerance &&
    Math.abs(panelRect.bottom - groupRect.bottom) <= tolerance
  );
}
