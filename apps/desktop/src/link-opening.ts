export const OPEN_LINKS_IN_DEFAULT_BROWSER_STORAGE_KEY =
  "ccsm.links.openInDefaultBrowser";

interface LinkOpeningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function storedOpenLinksInDefaultBrowser(value: string | null): boolean {
  return value === "true";
}

export class LinkOpeningController {
  #openInDefaultBrowser: boolean;

  constructor(private readonly storage: LinkOpeningStorage) {
    this.#openInDefaultBrowser = storedOpenLinksInDefaultBrowser(
      storage.getItem(OPEN_LINKS_IN_DEFAULT_BROWSER_STORAGE_KEY),
    );
  }

  get openInDefaultBrowser(): boolean {
    return this.#openInDefaultBrowser;
  }

  setOpenInDefaultBrowser(enabled: boolean): boolean {
    if (enabled === this.#openInDefaultBrowser)
      return this.#openInDefaultBrowser;
    this.#openInDefaultBrowser = enabled;
    this.storage.setItem(
      OPEN_LINKS_IN_DEFAULT_BROWSER_STORAGE_KEY,
      String(enabled),
    );
    return this.#openInDefaultBrowser;
  }

  toggleOpenInDefaultBrowser(): boolean {
    return this.setOpenInDefaultBrowser(!this.#openInDefaultBrowser);
  }
}
