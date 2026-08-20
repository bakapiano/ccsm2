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

import type { UpdateInfoDto } from "./generated/UpdateInfoDto";
import { SettingsDialog } from "./settings-dialog";
import { ThemeController } from "./theme";
import type { DesktopUpdateClient } from "./transport/desktop-client";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

const availableUpdate: UpdateInfoDto = {
  id: "candidate-1",
  currentVersion: "0.1.0-beta.6",
  version: "0.1.0-beta.7",
  notes: "Update notes",
  pubDate: "2026-08-20T02:00:00Z",
  source: "mirror-one",
};

describe("settings dialog", () => {
  test("changes theme, closes with Escape, and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const theme = createTheme();
    const setModalVisible = mock(async (_visible: boolean) => {});
    const dialog = new SettingsDialog({
      theme,
      updates: currentUpdateClient(),
      currentVersion: "0.1.0-beta.6",
      setModalVisible,
      prepareInstall: async () => true,
    });

    await dialog.open(trigger);
    const dark = requiredElement<HTMLButtonElement>(
      '[data-theme-choice="dark"]',
    );
    dark.click();
    expect(theme.current).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(document.querySelector(".settings-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(setModalVisible).toHaveBeenNthCalledWith(1, true);
    expect(setModalVisible).toHaveBeenNthCalledWith(2, false);
  });

  test("checks, downloads, prepares, and installs an update", async () => {
    const check = mock(async () => availableUpdate);
    const download = mock(
      async (
        _updateId: string,
        onProgress: (progress: {
          downloadedBytes: number;
          totalBytes: number | null;
          source: string;
        }) => void,
      ) => {
        onProgress({
          downloadedBytes: 512,
          totalBytes: 1024,
          source: "mirror-one",
        });
      },
    );
    const install = mock(async (_updateId: string) => {});
    const prepareInstall = mock(async () => true);
    const availability = mock((_available: boolean) => {});
    const dialog = new SettingsDialog({
      theme: createTheme(),
      updates: { check, download, install },
      currentVersion: "0.1.0-beta.6",
      setModalVisible: async () => {},
      prepareInstall,
      updateAvailabilityChanged: availability,
    });

    await dialog.open();
    expect(
      requiredElement<HTMLButtonElement>('[data-settings-action="upgrade"]')
        .hidden,
    ).toBe(true);
    await dialog.checkForUpdates(true);
    expect(document.querySelector(".settings-update-status")?.textContent).toBe(
      "Version 0.1.0-beta.7 is available.",
    );
    requiredElement<HTMLButtonElement>(
      '[data-settings-action="upgrade"]',
    ).click();
    await eventually(() => install.mock.calls.length === 1);

    expect(download).toHaveBeenCalledWith("candidate-1", expect.any(Function));
    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("candidate-1");
    expect(availability).toHaveBeenCalledWith(true);
  });

  test("reports the installed version as current", async () => {
    const dialog = new SettingsDialog({
      theme: createTheme(),
      updates: currentUpdateClient(),
      currentVersion: "0.1.0-beta.6",
      setModalVisible: async () => {},
      prepareInstall: async () => true,
    });
    await dialog.open();
    await dialog.checkForUpdates(true);
    expect(document.querySelector(".settings-update-status")?.textContent).toBe(
      "CCSM is up to date.",
    );
    expect(
      requiredElement<HTMLButtonElement>('[data-settings-action="upgrade"]')
        .hidden,
    ).toBe(true);
  });
});

function createTheme(): ThemeController {
  const values = new Map<string, string>();
  return new ThemeController(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    () => {},
  );
}

function currentUpdateClient(): DesktopUpdateClient {
  return {
    check: async () => null,
    download: async () => {},
    install: async () => {},
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("condition was not reached");
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
