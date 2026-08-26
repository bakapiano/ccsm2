import { describe, expect, test } from "bun:test";

import {
  LinkOpeningController,
  OPEN_LINKS_IN_DEFAULT_BROWSER_STORAGE_KEY,
  storedOpenLinksInDefaultBrowser,
} from "./link-opening";

describe("link opening preference", () => {
  test("uses the internal Browser until the preference is enabled", () => {
    expect(storedOpenLinksInDefaultBrowser(null)).toBe(false);
    expect(storedOpenLinksInDefaultBrowser("false")).toBe(false);
    expect(storedOpenLinksInDefaultBrowser("true")).toBe(true);
  });

  test("persists default-browser routing", () => {
    const values = new Map<string, string>();
    const controller = new LinkOpeningController({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });

    expect(controller.openInDefaultBrowser).toBe(false);
    expect(controller.toggleOpenInDefaultBrowser()).toBe(true);
    expect(values.get(OPEN_LINKS_IN_DEFAULT_BROWSER_STORAGE_KEY)).toBe("true");

    const restored = new LinkOpeningController({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });
    expect(restored.openInDefaultBrowser).toBe(true);
  });
});
