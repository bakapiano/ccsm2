import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { BrowserBounds } from "../generated/BrowserBounds";
import type { BrowserTitleChangedRequest } from "../generated/BrowserTitleChangedRequest";
import type { TabDto } from "../generated/TabDto";
import { BrowserFaviconStore } from "../browser-favicon";
import { planNativeVisibility } from "../browser-visibility";
import {
  clearBrowserSnapshot,
  presentBrowserSnapshot,
} from "../browser-snapshot";
import { browserTabTitle } from "../browser-title";
import { OrderedTaskQueue } from "../ordered-task-queue";
import { observePanelVisibility } from "../panel-visibility";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import { uiIcon } from "../ui-icons";
import type { TabProvider } from "./registry";

const DEFAULT_BROWSER_URL = "https://example.com/";

interface BrowserTabState {
  lastUrl: string;
  title?: string;
  zoom?: number;
}

interface BrowserTabProviderOptions {
  faviconStore?: BrowserFaviconStore;
  nativeSurfacesEnabled?: boolean;
}

export class BrowserTabProvider implements TabProvider {
  readonly kind = "browser" as const;
  readonly #panels = new Set<BrowserPanel>();
  #titleUnlisten: (() => void) | null = null;
  #destroyed = false;

  readonly #nativeSurfacesEnabled: boolean;
  readonly #faviconStore: BrowserFaviconStore;

  constructor(
    private readonly client: CcsmDesktopClient,
    options: BrowserTabProviderOptions = {},
  ) {
    this.#nativeSurfacesEnabled = options.nativeSurfacesEnabled ?? true;
    this.#faviconStore = options.faviconStore ?? new BrowserFaviconStore();
    void client.browser
      .subscribeTitleChanged((event) => {
        for (const panel of this.#panels) panel.handleTitleChanged(event);
      })
      .then((unlisten) => {
        if (this.#destroyed) unlisten();
        else this.#titleUnlisten = unlisten;
      });
  }

  createRenderer(tab: TabDto): IContentRenderer {
    const panel = new BrowserPanel(
      tab,
      this.client,
      this.#faviconStore,
      this.#nativeSurfacesEnabled,
      () => this.#panels.delete(panel),
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

  destroy(): void {
    this.#destroyed = true;
    this.#titleUnlisten?.();
    this.#titleUnlisten = null;
  }
}

class BrowserPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  readonly #surfaceId: string;
  #anchor: HTMLElement | null = null;
  #address: HTMLInputElement | null = null;
  #snapshot: HTMLImageElement | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #visibilitySubscription: { dispose(): void } | null = null;
  #panelApi: GroupPanelPartInitParameters["api"] | null = null;
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
  #zoom: number;
  #statePersistQueue: Promise<void> = Promise.resolve();
  #engine = "system WebView";
  #raf = 0;
  #syncing = false;
  #dirty = false;

  constructor(
    tab: TabDto,
    client: CcsmDesktopClient,
    private readonly faviconStore: BrowserFaviconStore,
    private readonly nativeSurfacesEnabled: boolean,
    private readonly onDispose: () => void,
  ) {
    this.#tab = tab;
    this.#client = client;
    this.#surfaceId = tab.resourceId ?? tab.id;
    const state = parseState(tab.state);
    this.#currentUrl = state.lastUrl;
    this.faviconStore.setPageUrl(tab.id, this.#currentUrl);
    this.#zoom = state.zoom ?? 1;
    this.element.className = "browser-panel";
    this.element.dataset.nativeVisible = "false";
    this.element.dataset.busy = "false";
    this.element.dataset.browserStatus = "starting";
    this.element.dataset.browserStatusMessage = "starting";
    this.element.innerHTML = `
      <form class="browser-toolbar panel-toolbar" autocomplete="off">
        <button class="browser-reload control-button control-button-icon" type="button" aria-label="Reload page" title="Reload page">
          ${uiIcon("refresh")}
        </button>
        <div class="browser-address-group">
          <input class="browser-address" aria-label="Browser address" spellcheck="false" />
          <button class="browser-go control-button control-button-icon" type="submit" aria-label="Go to address" title="Go to address">
            ${uiIcon("arrow-right")}
          </button>
        </div>
        <button class="browser-open-external control-button control-button-icon" type="button" aria-label="Open in default browser" title="Open in default browser">
          ${uiIcon("open-external")}
        </button>
      </form>
      <div class="browser-anchor" data-snapshot-visible="false" aria-label="Native browser viewport">
        <img class="browser-snapshot" alt="" aria-hidden="true" hidden />
      </div>
    `;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.#panelApi = parameters.api;
    this.#anchor = this.element.querySelector(".browser-anchor");
    this.#address = this.element.querySelector(".browser-address");
    this.#snapshot = this.element.querySelector(".browser-snapshot");
    if (!this.#anchor || !this.#address)
      throw new Error("browser panel DOM is incomplete");
    this.#address.value = this.#currentUrl;
    this.element
      .querySelector<HTMLButtonElement>(".browser-open-external")
      ?.addEventListener("click", () => {
        void this.#openExternal();
      });
    this.#syncOpenExternalButton();
    if (!this.nativeSurfacesEnabled) {
      this.#address.disabled = true;
      this.#setStatus("ready", "E2E Browser placeholder");
      this.#anchor.textContent = "Native Browser disabled for provider E2E";
      return;
    }
    this.element.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#navigate(this.#address!.value);
    });
    this.element
      .querySelector(".browser-reload")
      ?.addEventListener("click", () => {
        void this.#reload();
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
    this.#panelApi = null;
    document.removeEventListener("dragstart", this.#onDragStart, true);
    document.removeEventListener("dragend", this.#onDragEnd, true);
    if (this.#raf) cancelAnimationFrame(this.#raf);
    clearBrowserSnapshot(this.#anchor, this.#snapshot);
    void this.#queueVisibilitySync();
  }

  handleTitleChanged(event: BrowserTitleChangedRequest): void {
    if (this.#disposed || event.surfaceId !== this.#surfaceId) return;
    const previousUrl = this.#currentUrl;
    if (/^(https?:|about:)/i.test(event.url)) this.#currentUrl = event.url;
    this.faviconStore.setPageUrl(this.#tab.id, this.#currentUrl);
    const title = browserTabTitle(event.title, this.#currentUrl);
    if (title === this.#tab.title && previousUrl === this.#currentUrl) return;
    this.#tab.title = title;
    this.#panelApi?.setTitle(title);
    if (this.#address) this.#address.value = this.#currentUrl;
    this.#syncOpenExternalButton();
    void this.#persistState();
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

  async setOverlaySuspended(suspended: boolean): Promise<void> {
    if (suspended === this.#overlaySuspended) return;
    if (suspended) {
      await this.#captureOverlaySnapshot();
      this.#overlaySuspended = true;
      await this.#queueVisibilitySync();
      this.#scheduleSync();
      return;
    }

    this.#overlaySuspended = false;
    try {
      const bounds = this.#measureBounds();
      if (this.#created && bounds && boundsChanged(this.#lastBounds, bounds)) {
        await this.#client.browser.setBounds(this.#surfaceId, bounds);
        this.#lastBounds = bounds;
      }
      await this.#queueVisibilitySync();
    } finally {
      clearBrowserSnapshot(this.#anchor, this.#snapshot);
      this.#scheduleSync();
    }
  }

  async #captureOverlaySnapshot(): Promise<void> {
    if (
      !this.#created ||
      !this.#lastVisible ||
      !this.#anchor ||
      !this.#snapshot
    )
      return;
    try {
      const dataUrl = await this.#client.browser.capture(this.#surfaceId);
      if (this.#disposed || !this.#anchor || !this.#snapshot) return;
      await presentBrowserSnapshot(this.#anchor, this.#snapshot, dataUrl);
      delete this.element.dataset.snapshotError;
    } catch (error) {
      clearBrowserSnapshot(this.#anchor, this.#snapshot);
      this.element.dataset.snapshotError = describeError(error);
    }
  }

  #setDesiredVisible(visible: boolean): void {
    if (!this.nativeSurfacesEnabled) return;
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
    if (!this.nativeSurfacesEnabled) return;
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
        this.faviconStore.setPageUrl(this.#tab.id, this.#currentUrl);
        this.#address!.value = info.url;
        this.#syncOpenExternalButton();
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
    this.#setBusy(true);
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
      this.faviconStore.setPageUrl(this.#tab.id, this.#currentUrl);
      this.#syncOpenExternalButton();
      await this.#persistState();
      await this.#client.browser.focus(this.#surfaceId);
    } catch (error) {
      this.#setStatus("error", `navigate · ${describeError(error)}`);
    } finally {
      this.#setBusy(false);
    }
  }

  async #reload(): Promise<void> {
    if (!this.#created) return;
    this.#setBusy(true);
    try {
      await this.#client.browser.reload(this.#surfaceId);
      await this.#client.browser.focus(this.#surfaceId);
    } catch (error) {
      this.#setStatus("error", `reload · ${describeError(error)}`);
    } finally {
      this.#setBusy(false);
    }
  }

  async #openExternal(): Promise<void> {
    if (!canOpenInDefaultBrowser(this.#currentUrl)) return;
    const button = this.element.querySelector<HTMLButtonElement>(
      ".browser-open-external",
    );
    button?.setAttribute("aria-busy", "true");
    if (button) button.disabled = true;
    this.#setStatus("starting", "opening default browser");
    try {
      this.#currentUrl = await this.#client.browser.openExternal(
        this.#currentUrl,
      );
      if (this.#address) this.#address.value = this.#currentUrl;
      this.#setStatus("running", "opened in default browser");
    } catch (error) {
      this.#setStatus("error", `open external · ${describeError(error)}`);
    } finally {
      button?.removeAttribute("aria-busy");
      this.#syncOpenExternalButton();
    }
  }

  #syncOpenExternalButton(): void {
    const button = this.element.querySelector<HTMLButtonElement>(
      ".browser-open-external",
    );
    if (button) button.disabled = !canOpenInDefaultBrowser(this.#currentUrl);
  }

  #setBusy(busy: boolean): void {
    this.element.dataset.busy = String(busy);
    const reload =
      this.element.querySelector<HTMLButtonElement>(".browser-reload");
    reload?.setAttribute("aria-busy", String(busy));
  }

  #setStatus(state: string, text: string): void {
    this.element.dataset.browserStatus = state;
    this.element.dataset.browserStatusMessage = text;
  }

  #persistState(): Promise<void> {
    const title = this.#tab.title;
    const state: BrowserTabState = {
      lastUrl: this.#currentUrl,
      title,
      zoom: this.#zoom,
    };
    this.#tab.state = state;
    this.#statePersistQueue = this.#statePersistQueue
      .then(async () => {
        await this.#client.backend.updateTabState({
          tabId: this.#tab.id,
          title,
          stateVersion: 1,
          state,
        });
      })
      .catch((error) => {
        if (!this.#disposed)
          this.#setStatus("error", `title · ${describeError(error)}`);
      });
    return this.#statePersistQueue;
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

export function canOpenInDefaultBrowser(value: string): boolean {
  try {
    return ["http:", "https:", "ftp:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
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
