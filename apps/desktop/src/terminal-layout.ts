import { DebouncedTask } from "./terminal-flow";

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

const MIN_RENDERABLE_VIEWPORT_WIDTH = 320;
const MIN_RENDERABLE_VIEWPORT_HEIGHT = 200;
const TERMINAL_RESIZE_HANDLE_SELECTOR = [
  ".dv-sash.dv-enabled",
  ".sidebar-resizer",
  ".agents-resizer",
  "#window-resize-north",
].join(",");

export function isRenderableTerminalViewport(
  width: number,
  height: number,
): boolean {
  return (
    width >= MIN_RENDERABLE_VIEWPORT_WIDTH &&
    height >= MIN_RENDERABLE_VIEWPORT_HEIGHT
  );
}

export function isTerminalResizeHandle(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(
    element &&
      typeof element.closest === "function" &&
      element.closest(TERMINAL_RESIZE_HANDLE_SELECTOR),
  );
}

export class TerminalFitSettler {
  #gestureActive = false;
  #requested = false;

  constructor(
    delayMs: number,
    private readonly run: () => void,
    private readonly debounce = new DebouncedTask(delayMs),
  ) {}

  request(immediate = false): void {
    this.#requested = true;
    if (this.#gestureActive) return;
    this.debounce.cancel();
    if (immediate) {
      this.#requested = false;
      this.run();
      return;
    }
    this.debounce.schedule(() => {
      this.#requested = false;
      this.run();
    });
  }

  beginResizeGesture(): void {
    if (this.#gestureActive) return;
    this.#gestureActive = true;
    this.debounce.cancel();
  }

  endResizeGesture(): void {
    if (!this.#gestureActive) return;
    this.#gestureActive = false;
    if (this.#requested) this.request();
  }

  cancel(): void {
    this.debounce.cancel();
    this.#gestureActive = false;
    this.#requested = false;
  }

  get pending(): boolean {
    return this.#requested || this.debounce.pending;
  }

  get gestureActive(): boolean {
    return this.#gestureActive;
  }
}

export interface TerminalFrameSource {
  createFrameSnapshot(): HTMLCanvasElement | null;
}

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

export class TerminalFrameSwap {
  #snapshot: HTMLCanvasElement | null = null;
  #target: TerminalGridSize | null = null;

  constructor(private readonly panel: HTMLElement) {}

  capture(
    source: TerminalFrameSource,
    host: HTMLElement,
    target: TerminalGridSize,
  ): void {
    if (!this.#snapshot) {
      const snapshot = source.createFrameSnapshot();
      if (!snapshot) return;
      snapshot.classList.add("terminal-resize-snapshot");
      host.append(snapshot);
      this.#snapshot = snapshot;
      this.panel.dataset.resizeSnapshot = "true";
    }
    this.#target = { ...target };
  }

  matches(target: TerminalGridSize): boolean {
    return Boolean(
      this.#snapshot &&
        this.#target?.cols === target.cols &&
        this.#target.rows === target.rows,
    );
  }

  release(): void {
    this.#snapshot?.remove();
    this.#snapshot = null;
    this.#target = null;
    delete this.panel.dataset.resizeSnapshot;
    delete this.panel.dataset.resizePending;
  }

  get active(): boolean {
    return Boolean(this.#snapshot);
  }
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
