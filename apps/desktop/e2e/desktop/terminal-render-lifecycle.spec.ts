import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ScenarioEvidence } from "./support/evidence";

interface TerminalSnapshot {
  fitCount: number;
  renderActive: boolean;
  runtimeId: string | null;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const scenarioId = "terminal-render-lifecycle";
const sampleDurationMs = 800;

describe("Terminal rendering lifecycle", () => {
  it("keeps retained terminal rendering bounded across Space switches", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    const firstName = `Render A ${runId}`;
    const secondName = `Render B ${runId}`;
    const firstRoot = join(spaceRootBase, "renderer-a");
    const secondRoot = join(spaceRootBase, "renderer-b");
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });

    let currentStep = "create-first-space";
    let primaryError: unknown;
    try {
      await restoreScenarioUi();
      await createSpace(firstName, firstRoot);
      await stopActiveShell();
      const firstCallbacks = await countAnimationFrameCallbacks();
      expect(firstCallbacks).toBeGreaterThan(10);
      await evidence.checkpoint("first-terminal-idle");

      currentStep = "create-second-space";
      await createSpace(secondName, secondRoot);
      await stopActiveShell();
      const secondCallbacks = await countAnimationFrameCallbacks();
      await evidence.checkpoint("second-terminal-idle");

      currentStep = "return-to-first-space";
      await $(`button=${firstName}`).click();
      await browser.waitUntil(
        async () => (await activeSpaceName()) === firstName,
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg: `Space ${firstName} did not become active`,
        },
      );
      const returned = await waitForTerminal();
      expect(returned.renderActive).toBe(true);
      const returnCallbacks = await countAnimationFrameCallbacks();
      await evidence.checkpoint("first-terminal-restored");

      const allowance = Math.max(12, Math.ceil(firstCallbacks * 0.45));
      expect(secondCallbacks).toBeLessThanOrEqual(firstCallbacks + allowance);
      expect(returnCallbacks).toBeLessThanOrEqual(firstCallbacks + allowance);
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-metrics.json`),
        `${JSON.stringify(
          {
            sampleDurationMs,
            firstCallbacks,
            secondCallbacks,
            returnCallbacks,
            allowance,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      primaryError = error;
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-failure-context.json`),
        `${JSON.stringify(
          { scenarioId, failureStep: currentStep, error: String(error) },
          null,
          2,
        )}\n`,
      );
    } finally {
      try {
        await evidence.checkpoint(
          primaryError ? `failed-${currentStep}` : "final-state",
        );
      } catch (error) {
        primaryError ??= error;
      }
      try {
        evidence.finalize();
      } catch (error) {
        primaryError ??= error;
      }
    }

    if (primaryError) throw primaryError;
  });
});

async function countAnimationFrameCallbacks(): Promise<number> {
  await browser.pause(500);
  return browser.execute(async (durationMs) => {
    const original = window.requestAnimationFrame;
    let callbacks = 0;
    window.requestAnimationFrame = (callback) =>
      original.call(window, (timestamp) => {
        callbacks += 1;
        callback(timestamp);
      });
    try {
      await new Promise((resolve) => window.setTimeout(resolve, durationMs));
      return callbacks;
    } finally {
      window.requestAnimationFrame = original;
    }
  }, sampleDurationMs);
}

async function stopActiveShell(): Promise<void> {
  await waitForTerminal(true);
  const action = await $("[data-testid='terminal-runtime-action']");
  await action.waitForClickable({ timeout: 20_000 });
  if ((await action.getAttribute("data-intent")) === "stop") {
    await action.click();
    await browser.waitUntil(
      async () =>
        (await action.getAttribute("data-intent")) === "start" &&
        (await activeTerminalSnapshot())?.runtimeId === null,
      { timeout: 20_000, interval: 100, timeoutMsg: "Shell did not stop" },
    );
  }
}

async function waitForTerminal(
  requireRuntime = false,
): Promise<TerminalSnapshot> {
  let latest: TerminalSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await activeTerminalSnapshot();
      return Boolean(
        latest?.renderActive &&
          latest.fitCount > 0 &&
          (!requireRuntime || latest.runtimeId),
      );
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "Active terminal did not finish rendering",
    },
  );
  return latest!;
}

async function activeTerminalSnapshot(): Promise<TerminalSnapshot | null> {
  const serialized = await browser.execute(() => {
    const snapshot = [...document.querySelectorAll(".terminal-panel")]
      .map((panel) =>
        (
          panel as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.(),
      )
      .find((candidate) => candidate?.renderActive);
    return JSON.stringify(
      snapshot
        ? {
            fitCount: Number(snapshot.fitCount ?? 0),
            renderActive: Boolean(snapshot.renderActive),
            runtimeId: snapshot.runtimeId ?? null,
          }
        : null,
    );
  });
  return JSON.parse(serialized) as TerminalSnapshot | null;
}

async function restoreScenarioUi(): Promise<void> {
  await browser.maximizeWindow();
  await browser.setWindowRect(20, 20, 1320, 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await browser.execute(() =>
      Boolean(
        document.querySelector(".directory-dialog") ||
          document.querySelector(".app-dialog") ||
          !document.querySelector<HTMLElement>("#new-tab-menu")?.hidden,
      ),
    );
    if (!open) return;
    await browser.keys("Escape");
    await browser.pause(100);
  }
}

async function createSpace(name: string, root: string): Promise<void> {
  await $("#new-space").click();
  const picker = await $(".directory-dialog");
  await picker.waitForDisplayed();
  await $(".directory-address").setValue(root);
  await $(".directory-address-submit").click();
  const useFolder = await $(".directory-use");
  await browser.waitUntil(
    async () => {
      const breadcrumbs = await $$(".directory-breadcrumbs button");
      const selectedPath =
        await breadcrumbs[(await breadcrumbs.length) - 1]?.getAttribute(
          "title",
        );
      return Boolean(
        selectedPath &&
          normalizedPath(selectedPath) === normalizedPath(root) &&
          (await useFolder.isEnabled()),
      );
    },
    { timeout: 20_000, timeoutMsg: `${root} did not become selectable` },
  );
  await useFolder.click();

  const dialog = await $(".app-dialog");
  await dialog.waitForDisplayed();
  await $(".app-dialog-field input").setValue(name);
  await $("[data-dialog-action='submit']").click();
  await dialog.waitForDisplayed({ reverse: true });
  await browser.waitUntil(async () => (await activeSpaceName()) === name, {
    timeout: 30_000,
    interval: 200,
    timeoutMsg: `Space ${name} did not become active`,
  });
}

async function activeSpaceName(): Promise<string> {
  return browser.execute(
    () =>
      document.querySelector('.space-row[aria-selected="true"] .space-name')
        ?.textContent ?? "",
  );
}

function normalizedPath(path: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    canonicalPath = resolve(path);
  }
  const normalized = canonicalPath.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
