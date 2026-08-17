type BrowserFaviconListener = (faviconUrl: string | null) => void;

export class BrowserFaviconStore {
  readonly #faviconUrls = new Map<string, string | null>();
  readonly #listeners = new Map<string, Set<BrowserFaviconListener>>();

  setPageUrl(tabId: string, pageUrl: string): void {
    const faviconUrl = browserFaviconUrl(pageUrl);
    if (
      this.#faviconUrls.has(tabId) &&
      this.#faviconUrls.get(tabId) === faviconUrl
    )
      return;
    this.#faviconUrls.set(tabId, faviconUrl);
    for (const listener of this.#listeners.get(tabId) ?? []) {
      listener(faviconUrl);
    }
  }

  subscribe(
    tabId: string,
    listener: BrowserFaviconListener,
  ): { dispose(): void } {
    let listeners = this.#listeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(tabId, listeners);
    }
    listeners.add(listener);
    if (this.#faviconUrls.has(tabId)) {
      listener(this.#faviconUrls.get(tabId) ?? null);
    }
    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#listeners.delete(tabId);
      },
    };
  }
}

export function browserFaviconUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/favicon.ico";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function browserFaviconUrlFromState(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("lastUrl" in state)) {
    return null;
  }
  const lastUrl = (state as { lastUrl?: unknown }).lastUrl;
  return typeof lastUrl === "string" ? browserFaviconUrl(lastUrl) : null;
}
