import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { ScenarioEvidence } from "./support/evidence";

interface TerminalSnapshot {
  bufferLength: number;
  cellHeight: number;
  cellWidth: number;
  hasSelection: boolean;
  inputEnabled: boolean;
  lastOutputRuntimeId: string | null;
  provider: "shell";
  rows: number;
  runtimeId: string | null;
  scrollbackLength: number;
  selectedText: string;
  text: string;
  viewportY: number;
}

interface SelectionGeometry {
  endX: number;
  startX: number;
  y: number;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const platform = requiredEnvironment("CCSM_E2E_PLATFORM");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const scenarioId = "terminal-clipboard-interrupt";

describe("Terminal keyboard routing", () => {
  it("copies and pastes terminal text and interrupts with Control-C", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    const marker = `CCSM_COPY_${runId.replaceAll(/[^a-z0-9]/giu, "_")}`;
    const confirmedPath = join(spaceRootBase, "terminal", "interrupt.txt");
    const spaceName = `E2E Terminal ${runId}`;
    const spaceRoot = join(spaceRootBase, "terminal");
    mkdirSync(spaceRoot, { recursive: true });

    let currentStep = "create-space";
    let primaryError: unknown;
    try {
      await restoreScenarioUi();
      await createSpace(spaceName, spaceRoot);
      await waitForShell((snapshot) =>
        Boolean(
          snapshot.runtimeId &&
            snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
            snapshot.inputEnabled,
        ),
      );

      currentStep = "print-copy-marker";
      await typeShellLine(`echo ${marker}`);
      await waitForShell((snapshot) => snapshot.text.includes(marker));

      currentStep = "select-copy-marker";
      await selectTerminalText(marker);
      const selected = await waitForShell(
        (snapshot) =>
          snapshot.hasSelection && snapshot.selectedText.includes(marker),
      );
      expect(selected.selectedText).toContain(marker);
      await evidence.checkpoint("terminal-selection");

      currentStep = "copy-selection";
      await beginKeyboardCapture();
      await browser.keys(["Control", "c"]);
      await browser.pause(500);
      const keyboardEvents = await capturedKeyboardEvents();
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-keyboard-events.json`),
        `${JSON.stringify(keyboardEvents, null, 2)}\n`,
      );
      expect(keyboardEvents).toContainEqual(
        expect.objectContaining({ code: "KeyC", ctrlKey: true }),
      );
      await evidence.checkpoint("copy-shortcut");

      currentStep = "clear-selection";
      await clickTerminalCanvas();
      await waitForShell((snapshot) => !snapshot.hasSelection);

      currentStep = "paste-into-terminal";
      const occurrencesBeforePaste = terminalMarkerOccurrences(
        (await shellSnapshot())?.text ?? "",
        marker,
      );
      await browser.keys(["Control", "v"]);
      await waitForShell(
        (snapshot) =>
          terminalMarkerOccurrences(snapshot.text, marker) >
          occurrencesBeforePaste,
      );
      await evidence.checkpoint("terminal-pasted");
      await browser.keys(["Control", "c"]);
      await browser.pause(250);

      currentStep = "interrupt-running-command";
      const interruptCommand = "echo CCSM_INTERRUPT_READY; sleep 30";
      await typeShellLine(interruptCommand);
      await waitForShell((snapshot) =>
        snapshot.text.includes("CCSM_INTERRUPT_READY"),
      );
      await browser.keys(["Control", "c"]);
      await browser.pause(250);

      currentStep = "confirm-shell-resumed";
      const confirmationCommand =
        platform === "windows"
          ? `Set-Content -LiteralPath '${confirmedPath}' -Value confirmed`
          : `printf confirmed > '${confirmedPath}'`;
      await typeShellLine(confirmationCommand);
      await browser.waitUntil(() => existsSync(confirmedPath), {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "Shell did not resume after empty-selection Ctrl+C",
      });
      expect(readFileSync(confirmedPath, "utf8").trim()).toBe("confirmed");
      await evidence.checkpoint("pty-interrupted");
    } catch (error) {
      primaryError = error;
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-failure-context.json`),
        `${JSON.stringify(
          {
            scenarioId,
            failureStep: currentStep,
            error: String(error),
          },
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

async function selectTerminalText(marker: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const geometry = await selectionGeometry(marker);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({
        duration: 0,
        origin: "viewport",
        x: geometry.startX,
        y: geometry.y,
      })
      .down("left")
      .pause(50)
      .move({
        duration: 250,
        origin: "viewport",
        x: geometry.endX,
        y: geometry.y,
      })
      .up("left")
      .perform();
    const snapshot = await shellSnapshot();
    if (snapshot?.hasSelection && snapshot.selectedText.includes(marker))
      return;
  }
}

async function selectionGeometry(marker: string): Promise<SelectionGeometry> {
  const serialized = await browser.execute((target) => {
    const panel = [
      ...document.querySelectorAll<HTMLElement>(".terminal-panel"),
    ].find((candidate) => candidate.dataset.provider === "shell");
    const snapshot = (
      panel as
        | (HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          })
        | undefined
    )?.__CCSM_TERMINAL_DEBUG__?.();
    const canvas = panel?.querySelector<HTMLCanvasElement>(
      "canvas:not(.terminal-resize-snapshot)",
    );
    if (!snapshot || !canvas) throw new Error("Shell terminal is incomplete");

    const lines = snapshot.text.split("\n");
    let lineIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].includes(target)) {
        lineIndex = index;
        break;
      }
    }
    if (lineIndex < 0) throw new Error(`Marker ${target} is absent`);
    const column = lines[lineIndex].indexOf(target);
    const firstBufferLine = Math.max(0, snapshot.bufferLength - lines.length);
    const absoluteRow = firstBufferLine + lineIndex;
    const viewportRow =
      absoluteRow - snapshot.scrollbackLength + Math.floor(snapshot.viewportY);
    if (viewportRow < 0 || viewportRow >= snapshot.rows) {
      throw new Error(`Marker ${target} is outside the viewport`);
    }

    const rect = canvas.getBoundingClientRect();
    return JSON.stringify({
      startX: Math.round(rect.left + (column + 0.25) * snapshot.cellWidth),
      endX: Math.round(
        rect.left + (column + target.length - 0.25) * snapshot.cellWidth,
      ),
      y: Math.round(rect.top + (viewportRow + 0.5) * snapshot.cellHeight),
    });
  }, marker);
  return JSON.parse(serialized) as SelectionGeometry;
}

interface CapturedKeyboardEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

async function beginKeyboardCapture(): Promise<void> {
  await browser.execute(() => {
    const state = window as Window & {
      __CCSM_E2E_KEY_EVENTS__?: CapturedKeyboardEvent[];
    };
    state.__CCSM_E2E_KEY_EVENTS__ = [];
    document.addEventListener(
      "keydown",
      (event) =>
        state.__CCSM_E2E_KEY_EVENTS__?.push({
          altKey: event.altKey,
          code: event.code,
          ctrlKey: event.ctrlKey,
          key: event.key,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        }),
      true,
    );
  });
}

async function capturedKeyboardEvents(): Promise<CapturedKeyboardEvent[]> {
  return browser.execute(
    () =>
      (
        window as Window & {
          __CCSM_E2E_KEY_EVENTS__?: CapturedKeyboardEvent[];
        }
      ).__CCSM_E2E_KEY_EVENTS__ ?? [],
  );
}

async function clickTerminalCanvas(): Promise<void> {
  const point = await browser.execute(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.terminal-panel[data-provider="shell"] canvas:not(.terminal-resize-snapshot)',
    );
    if (!canvas) throw new Error("Shell terminal canvas is missing");
    const rect = canvas.getBoundingClientRect();
    return { x: Math.round(rect.left + 8), y: Math.round(rect.bottom - 9) };
  });
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: "viewport", x: point.x, y: point.y })
    .down("left")
    .up("left")
    .perform();
}

async function typeShellLine(input: string): Promise<void> {
  const panel = await $('.terminal-panel[data-provider="shell"]');
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const character of input) await browser.keys(character);
  await browser.keys("Enter");
}

async function waitForShell(
  predicate: (snapshot: TerminalSnapshot) => boolean,
): Promise<TerminalSnapshot> {
  let latest: TerminalSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await shellSnapshot();
      return Boolean(latest && predicate(latest));
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "Shell terminal did not reach the expected state",
    },
  );
  return latest!;
}

async function shellSnapshot(): Promise<TerminalSnapshot | null> {
  const serialized = await browser.execute(() => {
    for (const element of document.querySelectorAll<HTMLElement>(
      ".terminal-panel",
    )) {
      const snapshot = (
        element as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      if (snapshot?.provider === "shell") return JSON.stringify(snapshot);
    }
    return "null";
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

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function terminalMarkerOccurrences(value: string, marker: string): number {
  return countOccurrences(value.replaceAll("\n", ""), marker);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
