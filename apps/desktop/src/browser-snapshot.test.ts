import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  clearBrowserSnapshot,
  presentBrowserSnapshot,
} from "./browser-snapshot";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const providerSource = await Bun.file(
  new URL("./tabs/browser-provider.ts", import.meta.url),
).text();

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

describe("native Browser snapshot placeholder", () => {
  test("decodes the PNG before exposing it and releases it after restore", async () => {
    const anchor = document.createElement("div");
    anchor.dataset.snapshotVisible = "false";
    const image = document.createElement("img");
    image.hidden = true;
    const decode = mock(async () => {
      expect(image.hidden).toBe(true);
      expect(anchor.dataset.snapshotVisible).toBe("false");
    });
    Object.defineProperty(image, "decode", { value: decode });
    anchor.append(image);
    document.body.append(anchor);

    await presentBrowserSnapshot(
      anchor,
      image,
      "data:image/png;base64,iVBORw0KGgo=",
    );

    expect(decode).toHaveBeenCalledTimes(1);
    expect(image.hidden).toBe(false);
    expect(anchor.dataset.snapshotVisible).toBe("true");

    clearBrowserSnapshot(anchor, image);
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute("src")).toBe(false);
    expect(anchor.dataset.snapshotVisible).toBe("false");
  });

  test("rejects non-PNG capture payloads", async () => {
    const anchor = document.createElement("div");
    const image = document.createElement("img");

    await expect(
      presentBrowserSnapshot(anchor, image, "https://example.com/image.png"),
    ).rejects.toThrow("PNG data URL");
  });

  test("covers the native viewport without intercepting input", () => {
    expect(css).toMatch(
      /\.browser-snapshot\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*object-fit:\s*fill[^}]*pointer-events:\s*none/s,
    );
  });

  test("presents before native hide and releases after native show", () => {
    expect(providerSource).toMatch(
      /await this\.#captureOverlaySnapshot\(\);\s*this\.#overlaySuspended = true;\s*await this\.#queueVisibilitySync\(\)/,
    );
    expect(providerSource).toMatch(
      /this\.#overlaySuspended = false;[\s\S]*?await this\.#queueVisibilitySync\(\);\s*} finally {\s*clearBrowserSnapshot/,
    );
  });

  test("keeps Dockview popovers hidden while the snapshot is prepared", () => {
    expect(css).toMatch(
      /html\[data-browser-overlay-preparing="true"\] \.dv-context-menu,\s*html\[data-browser-overlay-preparing="true"\] \.dv-tabs-overflow-container\s*{\s*visibility:\s*hidden/,
    );
  });
});
