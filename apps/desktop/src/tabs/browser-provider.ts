import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { BrowserBounds } from "../generated/BrowserBounds";
import type { TabDto } from "../generated/TabDto";
import { planNativeVisibility } from "../browser-visibility";
import { OrderedTaskQueue } from "../ordered-task-queue";
import { observePanelVisibility } from "../panel-visibility";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import type { TabProvider } from "./registry";

const DEFAULT_BROWSER_URL = "https://example.com/";

interface BrowserTabState {
  lastUrl: string;
  title?: string;
  zoom?: number;
}

export class BrowserTabProvider implements TabProvider {
  readonly kind = "browser" as const;
  readonly #panels = new Set<BrowserPanel>();

  constructor(private readonly client: CcsmDesktopClient) {}

  createRenderer(tab: TabDto): IContentRenderer {
    const panel = new BrowserPanel(tab, this.client, () =>
      this.#panels.delete(panel),
    );
    this.#panels.add(panel);
    return panel;
  }

  setDockDragSuspended(suspended: boolean): void {
    for (const panel of this.#panels) panel.setDockDragSuspended(suspended);
  }

  async setOverlaySuspended(suspended: boolean): Promise<void> {
    await Promise.all(
      [...this.#panels].map((panel) => panel.setOverlaySuspended(suspended)),
    );
  }
}

class BrowserPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  readonly #surfaceId: string;
  #anchor: HTMLElement | null = null;
  #address: HTMLInputElement | null = null;
  #status: HTMLElement | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #visibilitySubscription: { dispose(): void } | null = null;
  #created = false;
  #creating = false;
  #desiredVisible = false;
  #disposed = false;
  #htmlDragSuspended = false;
  #dockDragSuspended = false;
  #overlaySuspended = false;
  #lastVisible = false;
  readonly #visibilityQueue = new OrderedTaskQueue();
  #lastBounds: BrowserBounds | null = null;
  #currentUrl: string;
  #engine = "system WebView";
  #raf = 0;
  #syncing = false;
  #dirty = false;

  constructor(
    tab: TabDto,
    client: CcsmDesktopClient,
    private readonly onDispose: () => void,
  ) {
    this.#tab = tab;
    this.#client = client;
    this.#surfaceId = tab.resourceId ?? tab.id;
    this.#currentUrl = parseState(tab.state).lastUrl;
    this.element.className = "browser-panel";
    this.element.dataset.nativeVisible = "false";
    this.element.innerHTML = `
      <form class="browser-toolbar" autocomplete="off">
        <button class="browser-reload" type="button" title="Reload">↻</button>
        <input class="browser-address" aria-label="Browser address" spellcheck="false" />
        <button class="browser-go" type="submit">Go</button>
        <span class="browser-state" data-state="starting">starting</span>
      </form>
      <div class="browser-anchor" aria-label="Native browser viewport"></div>
    `;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.#anchor = this.element.querySelector(".browser-anchor");
    this.#address = this.element.querySelector(".browser-address");
    this.#status = this.element.querySelector(".browser-state");
    if (!this.#anchor || !this.#address)
      throw new Error("browser panel DOM is incomplete");
    this.#address.value = this.#currentUrl;
    this.element.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#navigate(this.#address!.value);
    });
    this.element
      .querySelector(".browser-reload")
      ?.addEventListener("click", () => {
        if (this.#created) void this.#client.browser.reload(this.#surfaceId);
      });
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleSync());
    this.#resizeObserver.observe(this.#anchor);
    this.#visibilitySubscription = observePanelVisibility(
      parameters.api,
      (isVisible) => this.#setDesiredVisible(isVisible),
    );
    document.addEventListener("dragstart", this.#onDragStart, true);
    document.addEventListener("dragend", this.#onDragEnd, true);
    this.#scheduleSync();
  }

  layout(): void {
    this.#scheduleSync();
  }

  onShow(): void {
    this.#setDesiredVisible(true);
  }

  onHide(): void {
    this.#setDesiredVisible(false);
  }

  focus(): void {
    if (this.#created) void this.#client.browser.focus(this.#surfaceId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#desiredVisible = false;
    this.onDispose();
    this.#resizeObserver?.disconnect();
    this.#visibilitySubscription?.dispose();
    document.removeEventListener("dragstart", this.#onDragStart, true);
    document.removeEventListener("dragend", this.#onDragEnd, true);
    if (this.#raf) cancelAnimationFrame(this.#raf);
    void this.#queueVisibilitySync();
  }

  readonly #onDragStart = (): void => {
    this.#htmlDragSuspended = true;
    this.#syncAfterVisibilityConstraintChange();
  };

  readonly #onDragEnd = (): void => {
    this.#htmlDragSuspended = false;
    this.#syncAfterVisibilityConstraintChange();
  };

  setDockDragSuspended(suspended: boolean): void {
    this.#dockDragSuspended = suspended;
    this.#syncAfterVisibilityConstraintChange();
  }

  setOverlaySuspended(suspended: boolean): Promise<void> {
    this.#overlaySuspended = suspended;
    const hidden = this.#shouldShow()
      ? Promise.resolve()
      : this.#queueVisibilitySync();
    this.#scheduleSync();
    return hidden;
  }

  #setDesiredVisible(visible: boolean): void {
    this.#desiredVisible = visible;
    this.#syncAfterVisibilityConstraintChange();
  }

  #syncAfterVisibilityConstraintChange(): void {
    if (planNativeVisibility(this.#shouldShow()) === "hide-now") {
      void this.#queueVisibilitySync();
    }
    this.#scheduleSync();
  }

  #scheduleSync(): void {
    this.#dirty = true;
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      void this.#flushSync();
    });
  }

  async #flushSync(): Promise<void> {
    if (this.#syncing) return;
    this.#syncing = true;
    try {
      while (this.#dirty) {
        this.#dirty = false;
        await this.#syncOnce();
      }
    } finally {
      this.#syncing = false;
    }
  }

  async #syncOnce(): Promise<void> {
    const bounds = this.#measureBounds();
    const shouldShow = this.#shouldShow(bounds);
    if (!this.#created && shouldShow && bounds && !this.#creating) {
      this.#creating = true;
      this.#setStatus("starting", "creating native WebView");
      try {
        const info = await this.#client.browser.create(
          this.#surfaceId,
          bounds,
          this.#currentUrl,
        );
        this.#created = true;
        this.#engine = info.engine;
        this.#currentUrl = info.url;
        this.#address!.value = info.url;
        this.#lastBounds = bounds;
        this.#lastVisible = true;
        this.element.dataset.nativeVisible = "true";
        await this.#queueVisibilitySync();
        if (this.#lastVisible)
          this.#setStatus("running", `${info.engine} · ready`);
      } catch (error) {
        this.#setStatus("error", describeError(error));
      } finally {
        this.#creating = false;
      }
      return;
    }
    if (!this.#created) return;
    try {
      if (bounds && boundsChanged(this.#lastBounds, bounds)) {
        await this.#client.browser.setBounds(this.#surfaceId, bounds);
        this.#lastBounds = bounds;
      }
      await this.#queueVisibilitySync();
      if (this.#lastVisible)
        this.#setStatus("running", `${this.#engine} · ready`);
    } catch (error) {
      this.#setStatus("error", `sync · ${describeError(error)}`);
    }
  }

  #shouldShow(bounds = this.#measureBounds()): boolean {
    return Boolean(
      !this.#disposed &&
        bounds &&
        this.#desiredVisible &&
        !this.#htmlDragSuspended &&
        !this.#dockDragSuspended &&
        !this.#overlaySuspended,
    );
  }

  #queueVisibilitySync(): Promise<void> {
    return this.#visibilityQueue.enqueue(
      async () => {
        if (!this.#created) return;
        const shouldShow = this.#shouldShow();
        if (shouldShow === this.#lastVisible) return;
        await this.#client.browser.setVisible(this.#surfaceId, shouldShow);
        this.#lastVisible = shouldShow;
        this.element.dataset.nativeVisible = String(shouldShow);
      },
      (error) => {
        this.#setStatus("error", `visibility · ${describeError(error)}`);
      },
    );
  }

  #measureBounds(): BrowserBounds | null {
    if (!this.#anchor?.isConnected) return null;
    const rect = this.#anchor.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const width = Math.min(window.innerWidth, rect.right) - x;
    const height = Math.min(window.innerHeight, rect.bottom) - y;
    if (width < 2 || height < 2 || this.#anchor.getClientRects().length === 0)
      return null;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    };
  }

  async #navigate(value: string): Promise<void> {
    this.#currentUrl = normalizeBrowserInput(value);
    try {
      if (this.#created) {
        this.#currentUrl = await this.#client.browser.navigate(
          this.#surfaceId,
          this.#currentUrl,
        );
      } else {
        this.#scheduleSync();
      }
      this.#address!.value = this.#currentUrl;
      const state: BrowserTabState = { lastUrl: this.#currentUrl, zoom: 1 };
      await this.#client.backend.updateTabState({
        tabId: this.#tab.id,
        title: this.#tab.title,
        stateVersion: 1,
        state,
      });
      await this.#client.browser.focus(this.#surfaceId);
    } catch (error) {
      this.#setStatus("error", `navigate · ${describeError(error)}`);
    }
  }

  #setStatus(state: string, text: string): void {
    if (!this.#status) return;
    this.#status.dataset.state = state;
    this.#status.textContent = text;
  }
}

function parseState(value: unknown): BrowserTabState {
  if (value && typeof value === "object") {
    const candidate = value as Partial<BrowserTabState>;
    if (typeof candidate.lastUrl === "string") {
      return {
        lastUrl: candidate.lastUrl,
        ...(typeof candidate.title === "string"
          ? { title: candidate.title }
          : {}),
        ...(typeof candidate.zoom === "number" ? { zoom: candidate.zoom } : {}),
      };
    }
  }
  return { lastUrl: DEFAULT_BROWSER_URL, zoom: 1 };
}

function normalizeBrowserInput(value: string): string {
  const input = value.trim();
  if (!input) return DEFAULT_BROWSER_URL;
  if (/^(https?:|about:)/i.test(input)) return input;
  if (/\s/.test(input) || !input.includes(".")) {
    return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  }
  return `https://${input}`;
}

function boundsChanged(
  previous: BrowserBounds | null,
  next: BrowserBounds,
): boolean {
  if (!previous) return true;
  return (["x", "y", "width", "height"] as const).some(
    (key) => Math.abs(previous[key] - next[key]) > 0.25,
  );
}
