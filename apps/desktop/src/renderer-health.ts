import type { RendererHealthDebugSnapshot } from "./generated/RendererHealthDebugSnapshot";
import type { RendererInputProbe } from "./generated/RendererInputProbe";
import type { RendererReadyResponse } from "./generated/RendererReadyResponse";
import type { RendererHealthClient } from "./transport/desktop-client";

const INPUT_CORRELATION_WINDOW_MS = 250;
const RECENT_INPUT_RETENTION_MS = 2_000;

export interface RendererHealthAppSnapshot {
  dockDragging: boolean;
  sidebarResizing: boolean;
  agentsResizing: boolean;
  modalKind: "app" | "directory" | null;
  dirtyEditorCount: number;
  liveCliRuntimeCount: number;
}

export interface CapturedClick {
  atMs: number;
  targetClass: string | null;
}

export class RendererHealthController {
  readonly #recentClicks: CapturedClick[] = [];
  readonly #capturedPointerIds = new Set<number>();
  #lastPointerDownAtMs: number | null = null;
  #lastPointerUpAtMs: number | null = null;
  #lastClickAtMs: number | null = null;
  #unlisten: (() => void) | null = null;
  #suppressAcks = false;

  constructor(
    private readonly client: RendererHealthClient,
    private readonly snapshot: () => RendererHealthAppSnapshot,
    private readonly recovered: (response: RendererReadyResponse) => void,
  ) {}

  async install(): Promise<void> {
    window.addEventListener("pointerdown", this.#onPointerDown, true);
    window.addEventListener("pointerup", this.#onPointerUp, true);
    window.addEventListener("pointercancel", this.#onPointerUp, true);
    window.addEventListener(
      "gotpointercapture",
      this.#onGotPointerCapture,
      true,
    );
    window.addEventListener(
      "lostpointercapture",
      this.#onLostPointerCapture,
      true,
    );
    window.addEventListener("click", this.#onClick, true);
    this.#unlisten = await this.client.subscribeInputProbe((probe) => {
      void this.#acknowledgeProbe(probe);
    });
  }

  async markReady(): Promise<RendererReadyResponse> {
    const snapshot = this.snapshot();
    const response = await this.client.markReady({
      dirtyEditorCount: snapshot.dirtyEditorCount,
      liveCliRuntimeCount: snapshot.liveCliRuntimeCount,
    });
    if (response.recovered) this.recovered(response);
    return response;
  }

  dispose(): void {
    this.#unlisten?.();
    this.#unlisten = null;
    window.removeEventListener("pointerdown", this.#onPointerDown, true);
    window.removeEventListener("pointerup", this.#onPointerUp, true);
    window.removeEventListener("pointercancel", this.#onPointerUp, true);
    window.removeEventListener(
      "gotpointercapture",
      this.#onGotPointerCapture,
      true,
    );
    window.removeEventListener(
      "lostpointercapture",
      this.#onLostPointerCapture,
      true,
    );
    window.removeEventListener("click", this.#onClick, true);
  }

  setAckSuppressed(suppressed: boolean): void {
    this.#suppressAcks = suppressed;
  }

  debugSimulateClick(): Promise<number> {
    return this.client.debugSimulateClick();
  }

  debugSnapshot(): Promise<RendererHealthDebugSnapshot> {
    return this.client.debugSnapshot();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#lastPointerDownAtMs = Date.now();
    if (
      event.currentTarget instanceof Element &&
      event.currentTarget.hasPointerCapture?.(event.pointerId)
    ) {
      this.#capturedPointerIds.add(event.pointerId);
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    this.#lastPointerUpAtMs = Date.now();
    this.#capturedPointerIds.delete(event.pointerId);
  };

  readonly #onGotPointerCapture = (event: PointerEvent): void => {
    this.#capturedPointerIds.add(event.pointerId);
  };

  readonly #onLostPointerCapture = (event: PointerEvent): void => {
    this.#capturedPointerIds.delete(event.pointerId);
  };

  readonly #onClick = (event: MouseEvent): void => {
    const atMs = Date.now();
    this.#lastClickAtMs = atMs;
    this.#recentClicks.push({
      atMs,
      targetClass: stableTargetClass(event.target),
    });
    this.#pruneRecentClicks(atMs);
  };

  async #acknowledgeProbe(probe: RendererInputProbe): Promise<void> {
    if (this.#suppressAcks) return;
    const click = await this.#matchingClick(probe.observedAtMs);
    const snapshot = this.snapshot();
    await this.client.acknowledgeInput({
      inputSeq: probe.inputSeq,
      domClickObserved: click !== null,
      documentVisible: document.visibilityState === "visible",
      windowFocused: document.hasFocus(),
      lastPointerDownAtMs: this.#lastPointerDownAtMs,
      lastPointerUpAtMs: this.#lastPointerUpAtMs,
      lastClickAtMs: this.#lastClickAtMs,
      targetClass: click?.targetClass ?? null,
      capturedPointerCount: this.#capturedPointerIds.size,
      dockDragging: snapshot.dockDragging,
      sidebarResizing: snapshot.sidebarResizing,
      agentsResizing: snapshot.agentsResizing,
      modalKind: snapshot.modalKind,
      dirtyEditorCount: snapshot.dirtyEditorCount,
      liveCliRuntimeCount: snapshot.liveCliRuntimeCount,
    });
  }

  async #matchingClick(observedAtMs: number): Promise<CapturedClick | null> {
    const deadline = performance.now() + INPUT_CORRELATION_WINDOW_MS;
    while (true) {
      const match = takeClosestClick(
        this.#recentClicks,
        observedAtMs,
        INPUT_CORRELATION_WINDOW_MS,
      );
      if (match) return match;
      if (performance.now() >= deadline) return null;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
  }

  #pruneRecentClicks(nowMs: number): void {
    while (
      this.#recentClicks[0] &&
      nowMs - this.#recentClicks[0].atMs > RECENT_INPUT_RETENTION_MS
    ) {
      this.#recentClicks.shift();
    }
  }
}

export function takeClosestClick(
  clicks: CapturedClick[],
  observedAtMs: number,
  toleranceMs: number,
): CapturedClick | null {
  let matchIndex = -1;
  let matchDistance = Number.POSITIVE_INFINITY;
  clicks.forEach((click, index) => {
    const distance = Math.abs(click.atMs - observedAtMs);
    if (distance <= toleranceMs && distance < matchDistance) {
      matchIndex = index;
      matchDistance = distance;
    }
  });
  return matchIndex < 0 ? null : (clicks.splice(matchIndex, 1)[0] ?? null);
}

function stableTargetClass(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const className = [...target.classList]
    .find((value) => /^[a-z][a-z0-9_-]{0,63}$/i.test(value))
    ?.slice(0, 64);
  return className ?? target.tagName.toLowerCase().slice(0, 64);
}
