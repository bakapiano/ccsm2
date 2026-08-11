export async function presentBrowserSnapshot(
  anchor: HTMLElement,
  image: HTMLImageElement,
  dataUrl: string,
): Promise<void> {
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("browser snapshot is not a PNG data URL");
  }
  image.src = dataUrl;
  if (typeof image.decode === "function") await image.decode();
  image.hidden = false;
  anchor.dataset.snapshotVisible = "true";
}

export function clearBrowserSnapshot(
  anchor: HTMLElement | null,
  image: HTMLImageElement | null,
): void {
  if (anchor) anchor.dataset.snapshotVisible = "false";
  if (!image) return;
  image.hidden = true;
  image.removeAttribute("src");
}
