import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function recordStep(step: string): void {
  appendFileSync(
    join(artifactDirectory, "space-flow-steps.txt"),
    `${new Date().toISOString()} ${step}\n`,
  );
}

interface SpaceUiState {
  activeName: string;
  activeRoot: string;
  globalStatus: string;
  globalStatusState: string | null;
  activeRuntimeId: string | null;
  browserStatus: string;
  browserNativeVisible: boolean;
  spaces: Array<{
    id: string;
    name: string;
    root: string;
    active: boolean;
  }>;
}

async function spaceUiState(): Promise<SpaceUiState> {
  return browser.execute(() => {
    const terminal = document.querySelector<HTMLElement>(".terminal-panel");
    const terminalState = (
      terminal as HTMLElement & {
        __CCSM_TERMINAL_DEBUG__?: () => { runtimeId: string | null };
      }
    )?.__CCSM_TERMINAL_DEBUG__?.();
    const browserPanel = document.querySelector<HTMLElement>(".browser-panel");
    return {
      activeName:
        document.querySelector("#active-space-name")?.textContent ?? "",
      activeRoot:
        document.querySelector("#active-space-root")?.textContent ?? "",
      globalStatus: document.querySelector("#global-status")?.textContent ?? "",
      globalStatusState:
        document.querySelector("#global-status")?.getAttribute("data-state") ??
        null,
      activeRuntimeId: terminalState?.runtimeId ?? null,
      browserStatus:
        browserPanel?.querySelector(".browser-state")?.textContent ?? "",
      browserNativeVisible: browserPanel?.dataset.nativeVisible === "true",
      spaces: Array.from(
        document.querySelectorAll<HTMLElement>(".space-row[data-space-id]"),
        (row) => ({
          id: row.dataset.spaceId ?? "",
          name: row.querySelector(".space-name")?.textContent ?? "",
          root:
            row.querySelector<HTMLButtonElement>(".space-item")?.title ?? "",
          active: row.dataset.active === "true",
        }),
      ),
    };
  });
}

async function waitForActiveSpace(name: string): Promise<void> {
  await browser.waitUntil(
    async () => (await spaceUiState()).activeName === name,
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `Space ${name} did not become active`,
    },
  );
}

async function waitForActiveRuntime(): Promise<void> {
  await browser.waitUntil(
    async () => Boolean((await spaceUiState()).activeRuntimeId),
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "active Space Shell runtime did not start",
    },
  );
}

async function waitForBrowserReady(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await spaceUiState();
      return (
        state.browserNativeVisible && state.browserStatus.includes("ready")
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg:
        "active Space native Browser did not become ready and visible",
    },
  );
}

function captureWslgWindow(name: string): void {
  const script = join(repositoryRoot, "scripts", "capture-wslg-window.ps1");
  const output = join(artifactDirectory, name);
  const windowsScript = execFileSync("wslpath", ["-w", script], {
    encoding: "utf8",
  }).trim();
  const windowsOutput = execFileSync("wslpath", ["-w", output], {
    encoding: "utf8",
  }).trim();
  execFileSync(
    "pwsh.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsScript,
      "-OutputPath",
      windowsOutput,
    ],
    { stdio: "pipe" },
  );
}

describe("Linux Space workflow", () => {
  before(async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, "space-flow-steps.txt"), "");
    await browser.pause(2_000);
    await $("#app").waitForDisplayed();
  });

  it("creates a Space and switches both directions", async () => {
    await waitForActiveRuntime();
    await waitForBrowserReady();
    const initial = await spaceUiState();
    expect(initial.spaces).toHaveLength(1);
    const initialSpace = initial.spaces[0]!;
    writeFileSync(
      join(artifactDirectory, "space-initial.json"),
      `${JSON.stringify(initial, null, 2)}\n`,
    );

    recordStep("open directory picker");
    await $("#new-space").click();
    const picker = await $(".directory-dialog");
    await picker.waitForDisplayed();
    recordStep("directory picker opened");
    await browser.execute(() => {
      const input =
        document.querySelector<HTMLInputElement>(".directory-address");
      if (!input) throw new Error("directory address is missing");
      input.value = "/etc";
      document
        .querySelector<HTMLFormElement>(".directory-address-form")
        ?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
    });
    const useFolder = await $(".directory-use");
    await browser.waitUntil(async () => useFolder.isEnabled(), {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: "/etc did not become selectable",
    });
    recordStep("directory path selected");
    await useFolder.click();

    const nameDialog = await $(".app-dialog");
    await nameDialog.waitForDisplayed();
    recordStep("Space name dialog opened");
    const nameInput = await $(".app-dialog-field input");
    await nameInput.setValue("ETC E2E");
    recordStep("submit Space creation");
    await $("[data-dialog-action='submit']").click();
    recordStep("Space creation click returned");
    await nameDialog.waitForDisplayed({ reverse: true });
    recordStep("Space name dialog closed");

    await waitForActiveSpace("ETC E2E");
    await waitForActiveRuntime();
    await waitForBrowserReady();
    const created = await spaceUiState();
    writeFileSync(
      join(artifactDirectory, "space-created.json"),
      `${JSON.stringify(created, null, 2)}\n`,
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "space-created-renderer.png"),
    );
    captureWslgWindow("space-created-composited.png");
    recordStep("new Space active");

    await $(
      `.space-row[data-space-id="${initialSpace.id}"] .space-item`,
    ).click();
    await waitForActiveSpace(initialSpace.name);
    await waitForActiveRuntime();
    await waitForBrowserReady();
    recordStep("initial Space active again");
    const switchedBack = await spaceUiState();
    writeFileSync(
      join(artifactDirectory, "space-switched-back.json"),
      `${JSON.stringify(switchedBack, null, 2)}\n`,
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "space-switched-back-renderer.png"),
    );
    captureWslgWindow("space-switched-back-composited.png");
    expect(switchedBack.activeRuntimeId).toBe(initial.activeRuntimeId);

    const createdSpace = switchedBack.spaces.find(
      (space) => space.name === "ETC E2E",
    );
    expect(createdSpace).toBeDefined();
    await $(
      `.space-row[data-space-id="${createdSpace!.id}"] .space-item`,
    ).click();
    await waitForActiveSpace("ETC E2E");
    await waitForActiveRuntime();
    await waitForBrowserReady();
    recordStep("new Space active again");
    const switchedAgain = await spaceUiState();
    writeFileSync(
      join(artifactDirectory, "space-switched-again.json"),
      `${JSON.stringify(switchedAgain, null, 2)}\n`,
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "space-switched-again-renderer.png"),
    );
    captureWslgWindow("space-switched-again-composited.png");
    expect(switchedAgain.activeRoot).toBe("/etc");
    expect(switchedAgain.activeRuntimeId).toBe(created.activeRuntimeId);
  });
});
