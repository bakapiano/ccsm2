import type { RendererReadyResponse } from "./generated/RendererReadyResponse";

export const RENDERER_RECOVERY_NOTICE_DURATION_MS = 5_000;

export interface RendererRecoveryNoticeClock {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timeoutId: number): void;
}

const browserClock: RendererRecoveryNoticeClock = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
};

export class RendererRecoveryNotice {
  #notice: HTMLElement | null = null;
  #dismissTimer: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly durationMs = RENDERER_RECOVERY_NOTICE_DURATION_MS,
    private readonly clock: RendererRecoveryNoticeClock = browserClock,
  ) {}

  show(response: RendererReadyResponse): void {
    this.dismiss();

    const notice = document.createElement("aside");
    notice.className = "renderer-recovery-notice";
    notice.dataset.testid = "renderer-recovery-notice";

    const title = document.createElement("strong");
    title.textContent = "UI recovered";

    const detail = document.createElement("span");
    detail.textContent = response.incidentId
      ? `Input path restored · incident ${response.incidentId.slice(0, 8)}`
      : "Input path restored";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss recovery notice");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => this.dismiss());

    notice.append(title, detail, dismiss);
    this.root.append(notice);
    this.#notice = notice;
    this.#dismissTimer = this.clock.setTimeout(
      () => this.#dismissIfCurrent(notice),
      this.durationMs,
    );
  }

  dismiss(): void {
    if (this.#dismissTimer !== null) {
      this.clock.clearTimeout(this.#dismissTimer);
      this.#dismissTimer = null;
    }
    this.#notice?.remove();
    this.#notice = null;
  }

  dispose(): void {
    this.dismiss();
  }

  #dismissIfCurrent(notice: HTMLElement): void {
    if (this.#notice !== notice) return;
    this.#dismissTimer = null;
    notice.remove();
    this.#notice = null;
  }
}
