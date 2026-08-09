export interface PanelVisibilitySource {
  readonly isVisible: boolean;
  onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void): {
    dispose(): void;
  };
}

export function observePanelVisibility(
  source: PanelVisibilitySource,
  listener: (isVisible: boolean) => void,
): { dispose(): void } {
  const subscription = source.onDidVisibilityChange((event) =>
    listener(event.isVisible),
  );
  listener(source.isVisible);
  return subscription;
}

export function focusWhenPanelActive(
  source: { readonly isActive: boolean },
  focus: () => void,
): boolean {
  if (!source.isActive) return false;
  focus();
  return true;
}
