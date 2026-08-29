import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ScenarioEvidence } from "./support/evidence";
import {
  type Provider,
  readModelStubEvents,
  setModelResponse,
} from "./support/model-stub";

interface ProviderCase {
  provider: Provider;
  label: string;
  scenarioId: string;
}

interface TerminalSnapshot {
  cliSessionId: string | null;
  runtimeId: string | null;
  provider: Provider;
  bindingState: string | null;
  nativeSessionId: string | null;
  inputEnabled: boolean;
  inputEnqueuedEvents: number;
  inputWriteBatches: number;
  lastOutputRuntimeId: string | null;
  text: string;
  win32InputMode: boolean;
  cols: number | null;
  rows: number | null;
  cursorX: number | null;
  cursorY: number | null;
  cellWidth: number | null;
  cellHeight: number | null;
  theme: "light" | "dark";
}

interface ComposerPixelObservation {
  provider: Provider;
  theme: "light" | "dark";
  rgb: [number, number, number];
  count: number;
  sampledPixels: number;
  cursorRow: number;
}

interface TerminalInputTiming {
  mode: "single" | "burst";
  round: number;
  warmup: boolean;
  inputEvents: number;
  inputBytes: number;
  writeBatches: number;
  dispatchMs: number;
  echoMs: number;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const terminalStressBytes = optionalNonNegativeInteger(
  "CCSM_E2E_TERMINAL_STRESS_BYTES",
);
const terminalInputStressEvents = optionalNonNegativeInteger(
  "CCSM_E2E_TERMINAL_INPUT_EVENTS",
);
const terminalInputStressRounds = optionalNonNegativeInteger(
  "CCSM_E2E_TERMINAL_INPUT_ROUNDS",
  7,
);
const webdriverKey = {
  Control: "\uE009",
  Enter: "\uE007",
  Shift: "\uE008",
} as const;
const providerCases: ProviderCase[] = [
  { provider: "claude", label: "Claude", scenarioId: "claude-resume" },
  { provider: "codex", label: "Codex", scenarioId: "codex-resume" },
  { provider: "copilot", label: "GHCP", scenarioId: "ghcp-resume" },
];
const composerPixels: Record<
  Provider,
  Record<"light" | "dark", [number, number, number]>
> = {
  claude: {
    dark: [30, 30, 30],
    light: [255, 255, 255],
  },
  codex: {
    dark: [57, 57, 57],
    light: [244, 244, 244],
  },
  copilot: {
    dark: [30, 30, 30],
    light: [255, 255, 255],
  },
};

describe("real provider CLI with stubbed model API", () => {
  before(() => {
    mkdirSync(artifactDirectory, { recursive: true });
  });

  beforeEach(async () => {
    await restoreScenarioUi();
  });

  for (const providerCase of providerCases) {
    it(`creates a Space and resumes ${providerCase.label}`, async () => {
      const { provider, label, scenarioId } = providerCase;
      const evidence = new ScenarioEvidence(scenarioId);
      const spaceName = `E2E ${label} ${runId}`;
      const spaceRoot = join(spaceRootBase, provider);
      const firstPrompt = `${provider}-prompt-one`;
      const firstResponseMarker = `STUB_${provider.toUpperCase()}_RESPONSE_ONE`;
      const firstResponse = terminalResponse(firstResponseMarker);
      const secondPrompt = `${provider}-prompt-two`;
      const secondResponseMarker = `STUB_${provider.toUpperCase()}_RESPONSE_TWO`;
      const secondResponse = terminalResponse(secondResponseMarker);
      const sidePrompt = `${provider}-side-prompt`;
      const sideResponseMarker = `STUB_${provider.toUpperCase()}_SIDE_RESPONSE`;
      const sideResponse = terminalResponse(sideResponseMarker);
      const forkPrompt = `${provider}-fork-prompt`;
      const forkResponseMarker = `STUB_${provider.toUpperCase()}_FORK_RESPONSE`;
      const forkResponse = terminalResponse(forkResponseMarker);
      const clearPrompt = `${provider}-clear-prompt`;
      const clearResponseMarker = `STUB_${provider.toUpperCase()}_CLEAR_RESPONSE`;
      const clearResponse = terminalResponse(clearResponseMarker);
      const turnTimings: Array<{
        phase: "first" | "follow-up";
        responseBytes: number;
        elapsedMs: number;
      }> = [];
      const inputTimings: TerminalInputTiming[] = [];
      setModelResponse(provider, firstPrompt, firstResponse);

      let primaryError: unknown;
      let currentStep = "create-space";
      try {
        await createSpace(spaceName, spaceRoot);
        expect(await activeSpaceName()).toBe(spaceName);
        await evidence.checkpoint("space-created");

        currentStep = "create-cli";
        await openProviderTab(provider);
        await acknowledgeProviderStartup(provider);
        const started = await waitForProvider(provider, (snapshot) =>
          Boolean(
            snapshot.runtimeId &&
              snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
              snapshot.inputEnabled &&
              ["pending", "bound"].includes(snapshot.bindingState ?? "") &&
              terminalLooksReady(provider, snapshot.text) &&
              terminalPromptReady(provider, snapshot.text),
          ),
        );
        const firstRuntimeId = started.runtimeId!;
        await waitForStablePrompt(provider, firstRuntimeId);
        await evidence.checkpoint("cli-started");

        if (provider === "codex" && process.platform === "win32") {
          currentStep = "win32-modified-enter";
          await verifyWindowsCodexModifiedEnter(runId);
          await evidence.checkpoint("win32-modified-enter");
        }

        if (terminalInputStressEvents > 0) {
          currentStep = "input-latency";
          inputTimings.push(
            ...(await measureTerminalInputLatency(
              provider,
              firstRuntimeId,
              terminalInputStressEvents,
              terminalInputStressRounds,
            )),
          );
        }

        currentStep = "first-prompt";
        const firstTurnStartedAt = performance.now();
        await sendTerminalLine(provider, firstPrompt);
        const firstTurn = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.includes(firstResponseMarker) &&
            snapshot.bindingState === "bound" &&
            Boolean(snapshot.nativeSessionId) &&
            terminalPromptReady(provider, snapshot.text),
        );
        turnTimings.push({
          phase: "first",
          responseBytes: firstResponse.length,
          elapsedMs: performance.now() - firstTurnStartedAt,
        });
        const nativeSessionId = firstTurn.nativeSessionId!;
        await waitForAgentActivity(firstTurn.cliSessionId!, "idle");
        await waitForAgentMetadata(firstTurn.cliSessionId!, firstPrompt);
        await evidence.checkpoint("first-model-response");

        if (provider === "codex") {
          currentStep = "ephemeral-side-chat";
          setModelResponse(provider, sidePrompt, sideResponse);
          await sendTerminalSlashCommand(
            provider,
            `/btw ${sidePrompt}`,
            sidePrompt,
          );
          const sideChat = await waitForProvider(
            provider,
            (snapshot) =>
              snapshot.text.includes(sideResponseMarker) &&
              snapshot.text.includes("ctrl + / to switch"),
          );
          expect(sideChat.nativeSessionId).toBe(nativeSessionId);
          if (process.platform === "win32") {
            expect(sideChat.win32InputMode).toBe(true);
          }
          await pressControlSlash(provider);
          await waitForProvider(
            provider,
            (snapshot) => snapshot.text.includes("ctrl + / for side"),
            15_000,
          );
          await waitForStablePrompt(provider, firstRuntimeId);
          await evidence.checkpoint("ephemeral-side-chat-returned");
        }

        if (terminalStressBytes > 0) {
          currentStep = "follow-up-prompt";
          setModelResponse(provider, secondPrompt, secondResponse);
          const followUpTurnStartedAt = performance.now();
          await sendTerminalLine(provider, secondPrompt);
          const followUpTurn = await waitForProvider(
            provider,
            (snapshot) =>
              snapshot.text.includes(secondResponseMarker) &&
              snapshot.nativeSessionId === nativeSessionId &&
              terminalPromptReady(provider, snapshot.text),
          );
          turnTimings.push({
            phase: "follow-up",
            responseBytes: secondResponse.length,
            elapsedMs: performance.now() - followUpTurnStartedAt,
          });
          expect(followUpTurn.runtimeId).toBe(firstRuntimeId);
          await waitForAgentActivity(followUpTurn.cliSessionId!, "idle");
          await waitForAgentMetadata(followUpTurn.cliSessionId!, secondPrompt);
          assertModelResponses(provider, [
            [firstPrompt, firstResponse],
            [secondPrompt, secondResponse],
          ]);
          await evidence.checkpoint("follow-up-model-response");

          currentStep = "final-stop";
          await clickRuntimeAction(provider);
          await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
          await evidence.checkpoint("cli-stopped");
        } else {
          currentStep = "close-cli";
          await clickRuntimeAction(provider);
          await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
          await evidence.checkpoint("cli-closed");

          currentStep = "resume-cli";
          await clickRuntimeAction(provider);
          await acknowledgeProviderStartup(provider);
          const resumed = await waitForProvider(provider, (snapshot) =>
            Boolean(
              snapshot.runtimeId &&
                snapshot.runtimeId !== firstRuntimeId &&
                snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
                snapshot.inputEnabled &&
                snapshot.nativeSessionId === nativeSessionId &&
                snapshot.text.includes(firstPrompt) &&
                snapshot.text.includes(firstResponseMarker) &&
                terminalPromptReady(provider, snapshot.text),
            ),
          );
          expect(resumed.runtimeId).not.toBe(firstRuntimeId);
          expect(resumed.nativeSessionId).toBe(nativeSessionId);
          expect(resumed.text).toContain(firstPrompt);
          expect(resumed.text).toContain(firstResponseMarker);
          await waitForStablePrompt(provider, resumed.runtimeId!);
          await waitForAgentActivity(resumed.cliSessionId!, "idle");
          await waitForAgentMetadata(resumed.cliSessionId!, firstPrompt);
          await evidence.checkpoint("cli-resumed");

          currentStep = "resumed-prompt";
          setModelResponse(provider, secondPrompt, secondResponse);
          const resumedTurnStartedAt = performance.now();
          await sendTerminalLine(provider, secondPrompt);
          const secondTurn = await waitForProvider(
            provider,
            (snapshot) =>
              snapshot.text.includes(secondResponseMarker) &&
              snapshot.nativeSessionId === nativeSessionId &&
              terminalPromptReady(provider, snapshot.text),
          );
          turnTimings.push({
            phase: "follow-up",
            responseBytes: secondResponse.length,
            elapsedMs: performance.now() - resumedTurnStartedAt,
          });
          expect(secondTurn.runtimeId).toBe(resumed.runtimeId);
          await waitForAgentActivity(secondTurn.cliSessionId!, "idle");
          await waitForAgentMetadata(secondTurn.cliSessionId!, secondPrompt);
          assertModelResponses(provider, [
            [firstPrompt, firstResponse],
            [secondPrompt, secondResponse],
          ]);
          assertResumedModelContext(
            provider,
            firstPrompt,
            firstResponse,
            secondPrompt,
          );
          await evidence.checkpoint("resumed-model-response");

          if (provider === "codex") {
            currentStep = "persistent-fork";
            setModelResponse(provider, forkPrompt, forkResponse);
            await sendTerminalSlashCommand(
              provider,
              "/fork",
              undefined,
              (snapshot) => snapshot.text.includes("Thread forked from"),
            );
            await waitForStablePrompt(provider, resumed.runtimeId!);
            await sendTerminalLine(provider, forkPrompt);
            const forked = await waitForProvider(
              provider,
              (snapshot) =>
                snapshot.text.includes(forkResponseMarker) &&
                Boolean(
                  snapshot.nativeSessionId &&
                    snapshot.nativeSessionId !== nativeSessionId,
                ),
            );
            const forkSessionId = forked.nativeSessionId!;
            expect(forkSessionId).not.toBe(nativeSessionId);
            await waitForStablePrompt(provider, resumed.runtimeId!);
            await waitForAgentActivity(forked.cliSessionId!, "idle");
            await waitForAgentMetadata(forked.cliSessionId!, forkPrompt);
            await evidence.checkpoint("persistent-fork-bound");

            currentStep = "clear-session";
            setModelResponse(provider, clearPrompt, clearResponse);
            await sendTerminalSlashCommand(
              provider,
              "/clear",
              undefined,
              (snapshot) =>
                !snapshot.text.includes(forkResponseMarker) &&
                terminalPromptReady(provider, snapshot.text),
            );
            await waitForStablePrompt(provider, resumed.runtimeId!);
            await sendTerminalLine(provider, clearPrompt);
            const cleared = await waitForProvider(
              provider,
              (snapshot) =>
                snapshot.text.includes(clearResponseMarker) &&
                Boolean(
                  snapshot.nativeSessionId &&
                    snapshot.nativeSessionId !== forkSessionId,
                ),
            );
            expect(cleared.nativeSessionId).not.toBe(forkSessionId);
            await waitForAgentMetadata(cleared.cliSessionId!, clearPrompt);
            await evidence.checkpoint("clear-session-bound");
          }

          currentStep = "final-stop";
          await clickRuntimeAction(provider);
          await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
          await evidence.checkpoint("cli-stopped");
        }
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
        const supplementalErrors: unknown[] = [];
        try {
          await evidence.checkpoint(
            primaryError ? `failed-${currentStep}` : "final-state",
          );
        } catch (error) {
          supplementalErrors.push(error);
          writeDiagnostic(scenarioId, "final-screenshot", error);
        }
        try {
          await dismissKnownOverlays();
        } catch (error) {
          supplementalErrors.push(error);
          writeDiagnostic(scenarioId, "overlay-cleanup", error);
        }
        try {
          const snapshot = await terminalSnapshot(provider);
          if (snapshot?.runtimeId) await clickRuntimeAction(provider);
        } catch (error) {
          supplementalErrors.push(error);
          writeDiagnostic(scenarioId, "runtime-cleanup", error);
        }
        try {
          evidence.finalize();
        } catch (error) {
          supplementalErrors.push(error);
          writeDiagnostic(scenarioId, "gif-finalize", error);
        }
        if (terminalStressBytes > 0) {
          writeFileSync(
            join(artifactDirectory, `${scenarioId}-terminal-performance.json`),
            `${JSON.stringify(
              {
                provider,
                configuredResponseBytes: terminalStressBytes,
                turns: turnTimings,
              },
              null,
              2,
            )}\n`,
          );
        }
        if (terminalInputStressEvents > 0) {
          writeFileSync(
            join(artifactDirectory, `${scenarioId}-terminal-input.json`),
            `${JSON.stringify(
              {
                provider,
                configuredInputEvents: terminalInputStressEvents,
                configuredRounds: terminalInputStressRounds,
                samples: inputTimings,
              },
              null,
              2,
            )}\n`,
          );
        }
        if (!primaryError && supplementalErrors.length > 0) {
          [primaryError] = supplementalErrors;
        }
      }
      if (primaryError) throw primaryError;
    });
  }

  it("switches running CLI composer surfaces with the application theme", async () => {
    const scenarioId = "cli-theme-switch";
    const evidence = new ScenarioEvidence(scenarioId);
    const observations: ComposerPixelObservation[] = [];
    let activeProvider: Provider | null = null;
    let primaryError: unknown;
    let currentStep = "create-provider-space";

    try {
      for (const { provider, label } of providerCases) {
        currentStep = `${provider}-create-space`;
        const spaceRoot = join(spaceRootBase, provider, "theme-switch");
        mkdirSync(spaceRoot, { recursive: true });
        await createSpace(`E2E ${label} Theme ${runId}`, spaceRoot);

        currentStep = `${provider}-set-dark-theme`;
        await selectApplicationTheme("dark");

        currentStep = `${provider}-start-cli`;
        await openProviderTab(provider);
        activeProvider = provider;
        await acknowledgeProviderStartup(provider);
        const started = await waitForProvider(provider, (snapshot) =>
          Boolean(
            snapshot.runtimeId &&
              snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
              snapshot.inputEnabled &&
              terminalPromptReady(provider, snapshot.text),
          ),
        );
        await waitForStablePrompt(provider, started.runtimeId!);
        const dark = await terminalComposerPixel(provider);
        observations.push(dark);
        expect(dark.theme).toBe("dark");
        expect(dark.rgb).toEqual(composerPixels[provider].dark);
        expect(dark.count).toBeGreaterThan(dark.sampledPixels * 0.95);
        await evidence.checkpoint(`${provider}-dark`);

        currentStep = `${provider}-set-light-theme`;
        await selectApplicationTheme("light");
        let light: ComposerPixelObservation | null = null;
        await browser.waitUntil(
          async () => {
            light = await terminalComposerPixel(provider);
            return (
              light.theme === "light" &&
              light.rgb.join(",") === composerPixels[provider].light.join(",")
            );
          },
          {
            timeoutMsg: `${label} composer pixels did not change with the light theme`,
          },
        );
        observations.push(light!);
        expect(light!.rgb).toEqual(composerPixels[provider].light);
        expect(light!.count).toBeGreaterThan(light!.sampledPixels * 0.95);
        await evidence.checkpoint(`${provider}-light`);

        currentStep = `${provider}-stop-cli`;
        await clickRuntimeAction(provider);
        await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
        activeProvider = null;
      }
    } catch (error) {
      primaryError = error;
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-failure-context.json`),
        `${JSON.stringify(
          {
            scenarioId,
            failureStep: currentStep,
            observations,
            error: String(error),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-pixels.json`),
        `${JSON.stringify(observations, null, 2)}\n`,
      );
      if (activeProvider) {
        try {
          const snapshot = await terminalSnapshot(activeProvider);
          if (snapshot?.runtimeId) await clickRuntimeAction(activeProvider);
        } catch (error) {
          primaryError ??= error;
        }
      }
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

function terminalResponse(marker: string): string {
  if (terminalStressBytes === 0) return marker;
  const payloadLength = Math.max(0, terminalStressBytes - marker.length - 1);
  const pattern = "0123456789abcdef";
  const payload = pattern
    .repeat(Math.ceil(payloadLength / pattern.length))
    .slice(0, payloadLength);
  return `${payload}\n${marker}`;
}

async function selectApplicationTheme(theme: "light" | "dark"): Promise<void> {
  const current = await browser.execute(
    () => document.documentElement.dataset.theme ?? "light",
  );
  if (current === theme) return;
  const settingsButton = await $('[data-testid="settings-button"]');
  await settingsButton.waitForDisplayed();
  await settingsButton.click();
  const dialog = await $(".settings-dialog");
  await dialog.waitForDisplayed();
  await $(`[data-theme-choice="${theme}"]`).click();
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.documentElement.dataset.theme)) ===
      theme,
    { timeoutMsg: `Theme did not change to ${theme}` },
  );
  await $('[data-settings-action="close"]').click();
  await dialog.waitForDisplayed({ reverse: true });
}

async function terminalComposerPixel(
  provider: Provider,
): Promise<ComposerPixelObservation> {
  const serialized = await browser.execute((selectedProvider) => {
    const panel = document.querySelector<HTMLElement>(
      `.terminal-panel[data-provider="${CSS.escape(selectedProvider)}"]`,
    );
    const snapshot = (
      panel as HTMLElement & {
        __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
      }
    )?.__CCSM_TERMINAL_DEBUG__?.();
    const canvas = panel?.querySelector<HTMLCanvasElement>("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (
      !snapshot ||
      !canvas ||
      !context ||
      snapshot.cursorY === null ||
      !snapshot.rows ||
      !snapshot.cellHeight
    ) {
      return JSON.stringify({ error: "terminal composer pixels unavailable" });
    }

    const scaleY = canvas.height / (snapshot.rows * snapshot.cellHeight);
    const rowStart = Math.max(
      0,
      Math.floor(snapshot.cursorY * snapshot.cellHeight * scaleY),
    );
    const rowEnd = Math.min(
      canvas.height,
      Math.ceil((snapshot.cursorY + 1) * snapshot.cellHeight * scaleY),
    );
    const columnStart = Math.floor(canvas.width / 2);
    const pixels = context.getImageData(
      columnStart,
      rowStart,
      canvas.width - columnStart,
      Math.max(1, rowEnd - rowStart),
    ).data;
    const colors = new Map<string, number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) continue;
      const key = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
    const [dominant, count] = [...colors.entries()].sort(
      (left, right) => right[1] - left[1],
    )[0] ?? ["0,0,0", 0];
    return JSON.stringify({
      provider: selectedProvider,
      theme: snapshot.theme,
      rgb: dominant.split(",").map(Number),
      count,
      sampledPixels: pixels.length / 4,
      cursorRow: snapshot.cursorY,
    });
  }, provider);
  const observation = JSON.parse(serialized) as
    | ComposerPixelObservation
    | { error: string };
  if ("error" in observation) throw new Error(observation.error);
  return observation;
}

async function measureTerminalInputLatency(
  provider: Provider,
  runtimeId: string,
  burstEvents: number,
  rounds: number,
): Promise<TerminalInputTiming[]> {
  const samples: TerminalInputTiming[] = [];
  for (let round = 0; round <= rounds; round += 1) {
    for (const mode of ["single", "burst"] as const) {
      const marker = `qv${mode === "single" ? "s" : "b"}${round
        .toString(36)
        .padStart(3, "0")}zq`;
      const chunks =
        mode === "single"
          ? [marker]
          : [...Array(Math.max(0, burstEvents - 1)).fill("x"), marker];
      const dispatched = await dispatchTerminalInput(provider, chunks);
      let observedAt = dispatched.dispatchedAt;
      let observedWriteBatches = dispatched.writeBatchesBefore;
      await browser.waitUntil(
        async () => {
          const observation = await observeTerminalMarker(provider, marker);
          if (observation.visible) {
            observedAt = observation.observedAt;
            observedWriteBatches = observation.inputWriteBatches;
          }
          return observation.visible;
        },
        {
          timeout: 30_000,
          interval: 5,
          timeoutMsg: `${provider} did not echo ${mode} input marker ${marker}`,
        },
      );
      samples.push({
        mode,
        round,
        warmup: round === 0,
        inputEvents: chunks.length,
        inputBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
        writeBatches: observedWriteBatches - dispatched.writeBatchesBefore,
        dispatchMs: dispatched.dispatchedAt - dispatched.startedAt,
        echoMs: observedAt - dispatched.startedAt,
      });
      await dispatchTerminalInput(provider, ["\x03"]);
      await waitForStablePrompt(provider, runtimeId);
    }
  }
  return samples;
}

async function dispatchTerminalInput(
  provider: Provider,
  chunks: string[],
): Promise<{
  startedAt: number;
  dispatchedAt: number;
  writeBatchesBefore: number;
}> {
  return browser.execute(
    (requestedProvider, inputChunks) => {
      const panelAndSnapshot = [
        ...document.querySelectorAll<HTMLElement>(".terminal-panel"),
      ]
        .map((element) => ({
          element,
          snapshot: (
            element as HTMLElement & {
              __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
            }
          ).__CCSM_TERMINAL_DEBUG__?.(),
        }))
        .find(
          ({ snapshot }) =>
            snapshot?.provider === requestedProvider && snapshot.inputEnabled,
        );
      if (!panelAndSnapshot)
        throw new Error(`${requestedProvider} terminal panel is unavailable`);
      const input = panelAndSnapshot.element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Terminal input"]',
      );
      if (!input)
        throw new Error(`${requestedProvider} terminal input is unavailable`);
      input.focus();
      const startedAt = performance.now();
      for (const data of inputChunks) {
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            composed: true,
            data,
            inputType: "insertText",
          }),
        );
      }
      return {
        startedAt,
        dispatchedAt: performance.now(),
        writeBatchesBefore: Number(
          panelAndSnapshot.snapshot!.inputWriteBatches ?? 0,
        ),
      };
    },
    provider,
    chunks,
  );
}

async function observeTerminalMarker(
  provider: Provider,
  marker: string,
): Promise<{
  visible: boolean;
  observedAt: number;
  inputWriteBatches: number;
}> {
  return browser.execute(
    (requestedProvider, expectedMarker) => {
      for (const element of document.querySelectorAll<HTMLElement>(
        ".terminal-panel",
      )) {
        const snapshot = (
          element as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.();
        if (snapshot?.provider !== requestedProvider || !snapshot.inputEnabled)
          continue;
        return {
          visible: snapshot.text
            .replaceAll(/\s/gu, "")
            .includes(expectedMarker),
          observedAt: performance.now(),
          inputWriteBatches: Number(snapshot.inputWriteBatches ?? 0),
        };
      }
      return {
        visible: false,
        observedAt: performance.now(),
        inputWriteBatches: 0,
      };
    },
    provider,
    marker,
  );
}

function optionalNonNegativeInteger(name: string, fallback = 0): number {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `${name} must be a non-negative integer; received ${value}`,
    );
  }
  return Number(value);
}

async function ensureDesktopViewport(): Promise<void> {
  await browser.maximizeWindow();
  await browser.setWindowRect(20, 20, 1319, 799);
  await browser.setWindowRect(20, 20, 1320, 800);
  expect(await browser.getWindowHandle()).toBe("main");
  await browser.waitUntil(
    () =>
      browser.execute(
        () => window.innerWidth >= 900 && window.innerHeight >= 560,
      ),
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: "Desktop E2E viewport did not reach 900x560",
    },
  );
}

async function restoreScenarioUi(): Promise<void> {
  await ensureDesktopViewport();
  await dismissKnownOverlays();
}

async function dismissKnownOverlays(): Promise<void> {
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
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(
          !document.querySelector(".directory-dialog") &&
            !document.querySelector(".app-dialog") &&
            document.querySelector<HTMLElement>("#new-tab-menu")?.hidden,
        ),
      ),
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: "Desktop E2E overlays did not close",
    },
  );
}

function writeDiagnostic(
  scenarioId: string,
  operation: string,
  error: unknown,
): void {
  writeFileSync(
    join(artifactDirectory, `${scenarioId}-${operation}-error.txt`),
    `${String(error)}\n`,
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function createSpace(name: string, root: string): Promise<void> {
  await $("#new-space").click();
  const picker = await $(".directory-dialog");
  await picker.waitForDisplayed();
  const address = await $(".directory-address");
  await address.setValue(root);
  await $(".directory-address-submit").click();
  const useFolder = await $(".directory-use");
  await browser.waitUntil(
    async () => {
      const breadcrumbs = await $$(".directory-breadcrumbs button");
      const breadcrumbCount = await breadcrumbs.length;
      const selectedPath =
        await breadcrumbs[breadcrumbCount - 1]?.getAttribute("title");
      return Boolean(
        selectedPath &&
          normalizedPath(selectedPath) === normalizedPath(root) &&
          (await useFolder.isEnabled()),
      );
    },
    {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: `${root} did not become selectable`,
    },
  );
  await useFolder.click();

  const dialog = await $(".app-dialog");
  await dialog.waitForDisplayed();
  await $(".app-dialog-field input").setValue(name);
  await $("[data-dialog-action='submit']").click();
  await dialog.waitForDisplayed({ reverse: true });
  await browser.waitUntil(async () => (await activeSpaceName()) === name, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: `Space ${name} did not become active`,
  });
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

async function activeSpaceName(): Promise<string> {
  return browser.execute(
    () =>
      document.querySelector('.space-row[aria-selected="true"] .space-name')
        ?.textContent ?? "",
  );
}

async function openProviderTab(provider: Provider): Promise<void> {
  await $(".dock-new-tab-button").click();
  const menu = await $("#new-tab-menu");
  await menu.waitForDisplayed();
  await $(`#new-tab-menu [data-new-tab-action='${provider}']`).click();
  await menu.waitForDisplayed({ reverse: true });
}

async function terminalSnapshot(
  provider: Provider,
): Promise<TerminalSnapshot | null> {
  const serialized = await browser.execute((requestedProvider) => {
    let fallback: TerminalSnapshot | null = null;
    for (const element of document.querySelectorAll<HTMLElement>(
      ".terminal-panel",
    )) {
      const snapshot = (
        element as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      if (snapshot?.provider !== requestedProvider) continue;
      fallback ??= snapshot;
      if (snapshot.inputEnabled) return JSON.stringify(project(snapshot));
    }
    return JSON.stringify(fallback ? project(fallback) : null);

    function project(snapshot: TerminalSnapshot): TerminalSnapshot {
      return {
        cliSessionId: snapshot.cliSessionId ?? null,
        runtimeId: snapshot.runtimeId ?? null,
        provider: snapshot.provider,
        bindingState: snapshot.bindingState ?? null,
        nativeSessionId: snapshot.nativeSessionId ?? null,
        inputEnabled: Boolean(snapshot.inputEnabled),
        inputEnqueuedEvents: Number(snapshot.inputEnqueuedEvents ?? 0),
        inputWriteBatches: Number(snapshot.inputWriteBatches ?? 0),
        lastOutputRuntimeId: snapshot.lastOutputRuntimeId ?? null,
        text: String(snapshot.text ?? ""),
        win32InputMode: Boolean(snapshot.win32InputMode),
        cols: snapshot.cols ?? null,
        rows: snapshot.rows ?? null,
        cursorX: snapshot.cursorX ?? null,
        cursorY: snapshot.cursorY ?? null,
        cellWidth: snapshot.cellWidth ?? null,
        cellHeight: snapshot.cellHeight ?? null,
        theme: snapshot.theme,
      };
    }
  }, provider);
  return JSON.parse(serialized) as TerminalSnapshot | null;
}

async function waitForProvider(
  provider: Provider,
  predicate: (snapshot: TerminalSnapshot) => boolean,
  timeout = 90_000,
): Promise<TerminalSnapshot> {
  let latest: TerminalSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await terminalSnapshot(provider);
      if (latest) {
        writeFileSync(
          join(artifactDirectory, `${provider}-latest.json`),
          `${JSON.stringify(latest, null, 2)}\n`,
        );
      }
      return Boolean(latest && predicate(latest));
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${provider} did not reach the expected terminal state`,
    },
  );
  return latest!;
}

async function sendTerminalLine(
  provider: Provider,
  input: string,
): Promise<void> {
  await waitForProvider(
    provider,
    (snapshot) =>
      snapshot.inputEnabled &&
      Boolean(
        snapshot.runtimeId &&
          snapshot.lastOutputRuntimeId === snapshot.runtimeId,
      ),
  );
  const panel = await terminalPanel(provider);
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const character of input) await browser.keys(character);
  await waitForProvider(provider, (snapshot) => snapshot.text.includes(input));
  await browser.keys("Enter");
  if (!(await waitForModelRequest(provider, input, 8_000))) {
    await browser.keys("Enter");
  }
}

async function sendTerminalSlashCommand(
  provider: Provider,
  command: string,
  modelPrompt?: string,
  confirmation?: (snapshot: TerminalSnapshot) => boolean,
): Promise<void> {
  await waitForProvider(
    provider,
    (snapshot) =>
      snapshot.inputEnabled &&
      Boolean(
        snapshot.runtimeId &&
          snapshot.lastOutputRuntimeId === snapshot.runtimeId,
      ),
  );
  await dispatchTerminalInput(provider, [command]);
  await browser.keys("Enter");
  if (
    modelPrompt &&
    !(await waitForModelRequest(provider, modelPrompt, 8_000))
  ) {
    await browser.keys("Enter");
  } else if (confirmation) {
    try {
      await waitForProvider(provider, confirmation, 3_000);
    } catch {
      await browser.keys("Enter");
      await waitForProvider(provider, confirmation);
    }
  }
}

async function verifyWindowsCodexModifiedEnter(runId: string): Promise<void> {
  const safeRunId = runId.replaceAll(/[^a-z0-9]/giu, "_");
  const lines = [
    `codex-ctrl-enter-${safeRunId}`,
    "continued-with-shift-enter",
    "completed-on-third-line",
  ];
  const prompt = lines.join("\n");
  const responseMarker = `STUB_CODEX_MODIFIED_ENTER_${safeRunId}`;
  setModelResponse("codex", prompt, terminalResponse(responseMarker));

  await waitForProvider(
    "codex",
    (snapshot) =>
      snapshot.win32InputMode && terminalPromptReady("codex", snapshot.text),
  );
  const panel = await terminalPanel("codex");
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  await typeAndConfirmCodexLine(lines[0]);
  await pressModifiedEnter("Control");
  await typeAndConfirmCodexLine(lines[1]);
  await pressModifiedEnter("Shift");
  await typeAndConfirmCodexLine(lines[2]);
  await browser.keys("Enter");
  expect(await waitForModelRequest("codex", prompt, 15_000)).toBe(true);

  await waitForProvider(
    "codex",
    (snapshot) =>
      snapshot.text.includes(responseMarker) &&
      terminalPromptReady("codex", snapshot.text),
  );
}

async function typeAndConfirmCodexLine(line: string): Promise<void> {
  await browser.keys(line);
  await waitForProvider("codex", (snapshot) => snapshot.text.includes(line));
}

async function pressModifiedEnter(
  modifier: "Control" | "Shift",
): Promise<void> {
  await browser
    .action("key")
    .down(webdriverKey[modifier])
    .down(webdriverKey.Enter)
    .up(webdriverKey.Enter)
    .up(webdriverKey[modifier])
    .perform();
}

async function pressControlSlash(provider: Provider): Promise<void> {
  const panel = await terminalPanel(provider);
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  await browser.execute((requestedProvider) => {
    const panel = [
      ...document.querySelectorAll<HTMLElement>(".terminal-panel"),
    ].find((element) => element.dataset.provider === requestedProvider);
    const input = panel?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Terminal input"]',
    );
    if (!input)
      throw new Error(`${requestedProvider} terminal input is unavailable`);

    // Reproduce Chromium's physical slash event identity so this scenario
    // covers CCSM's Win32 key-record translation.
    const dispatch = (
      type: "keydown" | "keyup",
      init: KeyboardEventInit,
    ): void => {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          ...init,
        }),
      );
    };
    dispatch("keydown", {
      code: "ControlLeft",
      ctrlKey: true,
      key: "Control",
    });
    dispatch("keydown", { code: "Slash", ctrlKey: true, key: "/" });
    dispatch("keyup", { code: "Slash", ctrlKey: true, key: "/" });
    dispatch("keyup", { code: "ControlLeft", key: "Control" });
  }, provider);
}

async function waitForModelRequest(
  provider: Provider,
  prompt: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      readModelStubEvents(provider).some((event) => event.prompt === prompt)
    ) {
      return true;
    }
    await browser.pause(200);
  }
  return false;
}

async function acknowledgeProviderStartup(provider: Provider): Promise<void> {
  if (provider === "copilot") {
    let trustHandled = false;
    await browser.waitUntil(
      async () => {
        const snapshot = await terminalSnapshot(provider);
        if (!snapshot?.runtimeId) return false;
        if (snapshot.lastOutputRuntimeId !== snapshot.runtimeId) return false;
        if (!trustHandled && hasCopilotTrustPrompt(snapshot.text)) {
          trustHandled = true;
          await sendTerminalKeys(provider, ["Enter"]);
          return false;
        }
        return Boolean(
          snapshot.inputEnabled && terminalPromptReady(provider, snapshot.text),
        );
      },
      {
        timeout: 120_000,
        interval: 250,
        timeoutMsg: "GitHub Copilot did not complete its real CLI startup flow",
      },
    );
    return;
  }
  if (provider === "codex") {
    const handled = new Set<string>();
    await browser.waitUntil(
      async () => {
        const snapshot = await terminalSnapshot(provider);
        if (!snapshot?.runtimeId) return false;
        if (snapshot.lastOutputRuntimeId !== snapshot.runtimeId) return false;
        const prompts = [
          {
            id: "workspace-trust",
            present: hasCodexTrustPrompt,
            keys: ["Enter"],
          },
          {
            id: "windows-sandbox",
            present: hasCodexSandboxPrompt,
            keys: ["ArrowDown", "Enter"],
          },
        ];
        const prompt = prompts.find(
          (candidate) =>
            !handled.has(candidate.id) && candidate.present(snapshot.text),
        );
        if (prompt) {
          handled.add(prompt.id);
          await sendTerminalKeys(provider, prompt.keys);
          return false;
        }
        return Boolean(
          snapshot.inputEnabled && terminalPromptReady(provider, snapshot.text),
        );
      },
      {
        timeout: 120_000,
        interval: 250,
        timeoutMsg: "Codex did not complete its real CLI startup flow",
      },
    );
    return;
  }
  if (provider !== "claude") return;
  const handled = new Set<string>();
  await browser.waitUntil(
    async () => {
      const snapshot = await terminalSnapshot(provider);
      if (!snapshot?.runtimeId) return false;
      if (snapshot.lastOutputRuntimeId !== snapshot.runtimeId) return false;
      writeFileSync(
        join(artifactDirectory, `${provider}-latest.json`),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      );
      const prompts: Array<{
        id: string;
        present: (text: string) => boolean;
        keys: string[];
      }> = [
        { id: "theme", present: hasClaudeThemePrompt, keys: ["Enter"] },
        {
          id: "api-key",
          present: hasClaudeApiKeyPrompt,
          keys: ["ArrowUp", "Enter"],
        },
        {
          id: "security-notes",
          present: hasClaudeSecurityNotes,
          keys: ["Enter"],
        },
        {
          id: "workspace-trust",
          present: hasClaudeTrustPrompt,
          keys: ["Enter"],
        },
      ];
      const prompt = prompts.find(
        (candidate) =>
          !handled.has(candidate.id) && candidate.present(snapshot.text),
      );
      if (prompt) {
        handled.add(prompt.id);
        await sendTerminalKeys(provider, prompt.keys);
        return false;
      }
      return Boolean(
        snapshot.inputEnabled &&
          snapshot.bindingState === "bound" &&
          snapshot.nativeSessionId &&
          terminalLooksReady(provider, snapshot.text) &&
          terminalPromptReady(provider, snapshot.text),
      );
    },
    {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "Claude did not complete its real CLI startup flow",
    },
  );
}

async function sendTerminalKeys(
  provider: Provider,
  keys: string[],
): Promise<void> {
  const panel = await terminalPanel(provider);
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const key of keys) await browser.keys(key);
}

async function clickRuntimeAction(provider: Provider): Promise<void> {
  const before = await waitForProvider(provider, () => true);
  const previousRuntimeId = before.runtimeId;
  const panel = await terminalPanel(provider);
  const action = await panel.$('[data-testid="terminal-runtime-action"]');
  await action.waitForDisplayed({ timeout: 20_000 });
  await action.waitForEnabled({ timeout: 20_000 });
  await action.click();
  await waitForProvider(provider, (snapshot) =>
    previousRuntimeId
      ? !snapshot.runtimeId
      : Boolean(snapshot.runtimeId && snapshot.runtimeId !== previousRuntimeId),
  );
}

async function terminalPanel(provider: Provider) {
  const panel = await $(`.terminal-panel[data-provider="${provider}"]`);
  await panel.waitForDisplayed({ timeout: 20_000 });
  return panel;
}

async function waitForAgentActivity(
  cliSessionId: string,
  activity: string,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (sessionId, expectedActivity) =>
          document.querySelector<HTMLElement>(
            `.agent-item[data-cli-session-id="${CSS.escape(sessionId)}"]`,
          )?.dataset.activity === expectedActivity,
        cliSessionId,
        activity,
      ),
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `CLI session ${cliSessionId} did not become ${activity}`,
    },
  );
}

async function waitForAgentMetadata(
  cliSessionId: string,
  expectedTitle: string,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (sessionId, title) => {
          const row = document.querySelector<HTMLElement>(
            `.agent-item[data-cli-session-id="${CSS.escape(sessionId)}"]`,
          );
          const activeTime = row?.querySelector<HTMLTimeElement>(
            ".agent-item-active-time",
          );
          return Boolean(
            row?.dataset.displayTitle === title &&
              Number(row.dataset.lastActiveAt) > 0 &&
              activeTime?.textContent?.trim() &&
              activeTime.dateTime,
          );
        },
        cliSessionId,
        expectedTitle,
      ),
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `CLI session ${cliSessionId} did not show title ${expectedTitle} and last-active time`,
    },
  );
}

async function waitForStablePrompt(
  provider: Provider,
  runtimeId: string,
): Promise<void> {
  let previousTail = "";
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      const snapshot = await terminalSnapshot(provider);
      if (
        snapshot?.runtimeId !== runtimeId ||
        snapshot.lastOutputRuntimeId !== runtimeId ||
        !terminalPromptReady(provider, snapshot.text)
      ) {
        previousTail = "";
        stableSince = 0;
        return false;
      }
      const tail = snapshot.text.slice(-2_000);
      if (tail !== previousTail) {
        previousTail = tail;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 1_000;
    },
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `${provider} prompt did not stabilize`,
    },
  );
}

function assertModelResponses(
  provider: Provider,
  expected: Array<[prompt: string, response: string]>,
): void {
  const responses = readModelStubEvents(provider);
  for (const [prompt, response] of expected) {
    expect(
      responses.some(
        (event) => event.prompt === prompt && event.response === response,
      ),
    ).toBe(true);
  }
}

function assertResumedModelContext(
  provider: Provider,
  firstPrompt: string,
  firstResponse: string,
  secondPrompt: string,
): void {
  const events = readModelStubEvents(provider);
  const first = events.find((event) => event.prompt === firstPrompt);
  const resumed = events.find((event) => event.prompt === secondPrompt);
  expect(first).toBeDefined();
  expect(resumed).toBeDefined();
  const carriesInlineHistory = Boolean(
    resumed?.configuredPromptsPresent.includes(firstPrompt) &&
      resumed.configuredResponsesPresent.includes(firstResponse),
  );
  const chainsPreviousResponse = Boolean(
    first?.responseId && resumed?.previousResponseId === first.responseId,
  );
  expect(carriesInlineHistory || chainsPreviousResponse).toBe(true);
}

function terminalLooksReady(provider: Provider, text: string): boolean {
  if (!text.trim()) return false;
  const markers: Record<Provider, RegExp> = {
    claude: /Claude|❯|>/iu,
    codex: /Codex|›|>/iu,
    copilot: /Copilot|What can I help|>/iu,
  };
  return markers[provider].test(text);
}

function terminalPromptReady(provider: Provider, text: string): boolean {
  const symbols: Record<Provider, string[]> = {
    claude: ["❯"],
    codex: ["›", ">"],
    copilot: [">", "❯"],
  };
  const last = symbols[provider]
    .map((symbol) => ({ index: text.lastIndexOf(symbol), symbol }))
    .sort((left, right) => right.index - left.index)[0];
  if (!last || last.index < 0) return false;
  const after = text.slice(last.index + last.symbol.length);
  if (provider === "codex") {
    const firstLine = after.split("\n", 1)[0].replaceAll("\u00a0", " ").trim();
    return (
      text.includes("gpt-5.6-sol default") &&
      !firstLine.includes("codex-prompt-")
    );
  }
  return /^[ \u00a0]*\n/u.test(after);
}

function hasClaudeApiKeyPrompt(text: string): boolean {
  return text
    .replace(/\s+/gu, "")
    .toLowerCase()
    .includes("doyouwanttousethisapikey?");
}

function hasClaudeThemePrompt(text: string): boolean {
  return text
    .replace(/\s+/gu, "")
    .toLowerCase()
    .includes("choosethetextstylethatlooksbestwithyourterminal");
}

function hasClaudeTrustPrompt(text: string): boolean {
  return text
    .replace(/\s+/gu, "")
    .toLowerCase()
    .includes("yes,itrustthisfolder");
}

function hasClaudeSecurityNotes(text: string): boolean {
  const compact = text.replace(/\s+/gu, "").toLowerCase();
  return (
    compact.includes("securitynotes:") &&
    compact.includes("pressentertocontinue")
  );
}

function hasCodexTrustPrompt(text: string): boolean {
  return text
    .replace(/\s+/gu, "")
    .toLowerCase()
    .includes("doyoutrustthecontentsofthisdirectory?");
}

function hasCodexSandboxPrompt(text: string): boolean {
  const compact = text.replace(/\s+/gu, "").toLowerCase();
  return (
    compact.includes("setupthecodexagentsandbox") &&
    compact.includes("usenon-adminsandbox")
  );
}

function hasCopilotTrustPrompt(text: string): boolean {
  const compact = text.replace(/\s+/gu, "").toLowerCase();
  return (
    compact.includes("confirmfoldertrust") &&
    compact.includes("doyoutrustthefilesinthisfolder?")
  );
}
