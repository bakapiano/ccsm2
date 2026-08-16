import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScenarioEvidence } from "./support/evidence";
import {
  type ModelMockEvent,
  type Provider,
  readModelMockEvents,
  setModelResponse,
} from "./support/model-mock";

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
  text: string;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const providerCases: ProviderCase[] = [
  { provider: "claude", label: "Claude", scenarioId: "claude-resume" },
  { provider: "codex", label: "Codex", scenarioId: "codex-resume" },
  { provider: "copilot", label: "GHCP", scenarioId: "ghcp-resume" },
];

describe("mocked provider resume", () => {
  before(() => {
    mkdirSync(artifactDirectory, { recursive: true });
  });

  for (const providerCase of providerCases) {
    it(`creates a Space and resumes ${providerCase.label}`, async () => {
      const { provider, label, scenarioId } = providerCase;
      const evidence = new ScenarioEvidence(scenarioId);
      const spaceName = `E2E ${label} ${runId}`;
      const spaceRoot = join(spaceRootBase, provider);
      const firstPrompt = `${provider}-prompt-one`;
      const firstResponse = `MOCK_${provider.toUpperCase()}_RESPONSE_ONE`;
      const secondPrompt = `${provider}-prompt-two`;
      const secondResponse = `MOCK_${provider.toUpperCase()}_RESPONSE_TWO`;
      setModelResponse(provider, firstPrompt, firstResponse);

      let primaryError: unknown;
      let currentStep = "create-space";
      try {
        await createSpace(spaceName, spaceRoot);
        expect(await activeSpaceName()).toBe(spaceName);
        await evidence.checkpoint("space-created");

        currentStep = "create-cli";
        await openProviderTab(provider);
        const bindsOnFirstPrompt = provider !== "claude";
        const started = await waitForProvider(provider, (snapshot) =>
          Boolean(
            snapshot.runtimeId &&
              snapshot.inputEnabled &&
              (bindsOnFirstPrompt
                ? snapshot.bindingState === "pending" &&
                  !snapshot.nativeSessionId
                : snapshot.bindingState === "bound" &&
                  snapshot.nativeSessionId) &&
              snapshot.text.includes("CCSM_E2E_READY>"),
          ),
        );
        if (bindsOnFirstPrompt) {
          expect(
            readModelMockEvents(provider).filter(
              (event) => event.event === "session-start",
            ),
          ).toHaveLength(0);
        }
        const firstRuntimeId = started.runtimeId!;
        await evidence.checkpoint("cli-started");

        currentStep = "first-prompt";
        await sendTerminalLine(provider, firstPrompt);
        const firstTurn = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.includes(firstResponse) &&
            snapshot.bindingState === "bound" &&
            Boolean(snapshot.nativeSessionId),
        );
        const nativeSessionId = firstTurn.nativeSessionId!;
        await evidence.checkpoint("first-model-response");

        currentStep = "close-cli";
        await clickRuntimeAction(provider);
        await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
        await evidence.checkpoint("cli-closed");

        currentStep = "resume-cli";
        await clickRuntimeAction(provider);
        const resumed = await waitForProvider(provider, (snapshot) =>
          Boolean(
            snapshot.runtimeId &&
              snapshot.runtimeId !== firstRuntimeId &&
              snapshot.inputEnabled &&
              snapshot.nativeSessionId === nativeSessionId &&
              snapshot.text.includes(
                `CCSM E2E ${provider} mock resumed session`,
              ),
          ),
        );
        expect(resumed.runtimeId).not.toBe(firstRuntimeId);
        expect(resumed.nativeSessionId).toBe(nativeSessionId);
        assertResumeInvocation(provider, nativeSessionId);
        await evidence.checkpoint("cli-resumed");

        currentStep = "resumed-prompt";
        setModelResponse(provider, secondPrompt, secondResponse);
        await sendTerminalLine(provider, secondPrompt);
        const secondTurn = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.includes(secondResponse) &&
            snapshot.nativeSessionId === nativeSessionId,
        );
        expect(secondTurn.runtimeId).toBe(resumed.runtimeId);
        assertModelResponses(provider, [
          [firstPrompt, firstResponse],
          [secondPrompt, secondResponse],
        ]);
        await evidence.checkpoint("resumed-model-response");

        currentStep = "final-stop";
        await clickRuntimeAction(provider);
        await waitForProvider(provider, (snapshot) => !snapshot.runtimeId);
        await evidence.checkpoint("cli-stopped");
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
        if (!primaryError && supplementalErrors.length > 0) {
          [primaryError] = supplementalErrors;
        }
      }
      if (primaryError) throw primaryError;
    });
  }
});

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
  await browser.keys("Enter");
  const useFolder = await $(".directory-use");
  await browser.waitUntil(() => useFolder.isEnabled(), {
    timeout: 20_000,
    interval: 200,
    timeoutMsg: `${root} did not become selectable`,
  });
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

async function activeSpaceName(): Promise<string> {
  return browser.execute(
    () => document.querySelector("#active-space-name")?.textContent ?? "",
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
  return browser.execute((requestedProvider) => {
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
      if (snapshot.inputEnabled) return snapshot;
    }
    return fallback;
  }, provider);
}

async function waitForProvider(
  provider: Provider,
  predicate: (snapshot: TerminalSnapshot) => boolean,
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
      timeout: 45_000,
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
  await waitForProvider(provider, (snapshot) => snapshot.inputEnabled);
  const panel = await terminalPanel(provider);
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  await browser.keys(input);
  await browser.keys("Enter");
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

function assertResumeInvocation(
  provider: Provider,
  nativeSessionId: string,
): void {
  const starts = readModelMockEvents(provider).filter(
    (event) => event.event === "session-start",
  );
  expect(starts.length).toBeGreaterThanOrEqual(2);
  const initial = starts.at(-2)!;
  const resumed = starts.at(-1)!;
  expect(initial.resumed).toBe(false);
  expect(resumed.resumed).toBe(true);
  expect(resumed.nativeSessionId).toBe(nativeSessionId);
  expect(resumed.nativeSessionId).toBe(initial.nativeSessionId);
  expect(resumeArgumentsContain(provider, resumed, nativeSessionId)).toBe(true);
}

function resumeArgumentsContain(
  provider: Provider,
  event: ModelMockEvent,
  nativeSessionId: string,
): boolean {
  const args = event.arguments ?? [];
  if (provider === "copilot") {
    return args.includes(`--resume=${nativeSessionId}`);
  }
  const resumeIndex = args.lastIndexOf("resume");
  const longResumeIndex = args.lastIndexOf("--resume");
  return (
    (resumeIndex >= 0 && args[resumeIndex + 1] === nativeSessionId) ||
    (longResumeIndex >= 0 && args[longResumeIndex + 1] === nativeSessionId)
  );
}

function assertModelResponses(
  provider: Provider,
  expected: Array<[prompt: string, response: string]>,
): void {
  const responses = readModelMockEvents(provider).filter(
    (event) => event.event === "model-response",
  );
  for (const [prompt, response] of expected) {
    expect(
      responses.some(
        (event) => event.prompt === prompt && event.response === response,
      ),
    ).toBe(true);
  }
}
