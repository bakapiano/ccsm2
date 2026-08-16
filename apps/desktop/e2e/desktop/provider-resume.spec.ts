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

describe("real provider CLI with stubbed model API", () => {
  before(() => {
    mkdirSync(artifactDirectory, { recursive: true });
  });

  beforeEach(async () => {
    await ensureDesktopViewport();
  });

  for (const providerCase of providerCases) {
    it(`creates a Space and resumes ${providerCase.label}`, async () => {
      const { provider, label, scenarioId } = providerCase;
      const evidence = new ScenarioEvidence(scenarioId);
      const spaceName = `E2E ${label} ${runId}`;
      const spaceRoot = join(spaceRootBase, provider);
      const firstPrompt = `${provider}-prompt-one`;
      const firstResponse = `STUB_${provider.toUpperCase()}_RESPONSE_ONE`;
      const secondPrompt = `${provider}-prompt-two`;
      const secondResponse = `STUB_${provider.toUpperCase()}_RESPONSE_TWO`;
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
              snapshot.inputEnabled &&
              ["pending", "bound"].includes(snapshot.bindingState ?? "") &&
              terminalLooksReady(provider, snapshot.text) &&
              terminalPromptReady(provider, snapshot.text),
          ),
        );
        const firstRuntimeId = started.runtimeId!;
        await waitForStablePrompt(provider, firstRuntimeId);
        await evidence.checkpoint("cli-started");

        currentStep = "first-prompt";
        await sendTerminalLine(provider, firstPrompt);
        const firstTurn = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.includes(firstResponse) &&
            snapshot.bindingState === "bound" &&
            Boolean(snapshot.nativeSessionId) &&
            terminalPromptReady(provider, snapshot.text),
        );
        const nativeSessionId = firstTurn.nativeSessionId!;
        await waitForAgentActivity(firstTurn.cliSessionId!, "idle");
        await evidence.checkpoint("first-model-response");

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
              snapshot.inputEnabled &&
              snapshot.nativeSessionId === nativeSessionId &&
              terminalPromptReady(provider, snapshot.text),
          ),
        );
        expect(resumed.runtimeId).not.toBe(firstRuntimeId);
        expect(resumed.nativeSessionId).toBe(nativeSessionId);
        await waitForStablePrompt(provider, resumed.runtimeId!);
        await waitForAgentActivity(resumed.cliSessionId!, "idle");
        await evidence.checkpoint("cli-resumed");

        currentStep = "resumed-prompt";
        setModelResponse(provider, secondPrompt, secondResponse);
        await sendTerminalLine(provider, secondPrompt);
        const secondTurn = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.includes(secondResponse) &&
            snapshot.nativeSessionId === nativeSessionId &&
            terminalPromptReady(provider, snapshot.text),
        );
        expect(secondTurn.runtimeId).toBe(resumed.runtimeId);
        await waitForAgentActivity(secondTurn.cliSessionId!, "idle");
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

async function ensureDesktopViewport(): Promise<void> {
  await browser.maximizeWindow();
  await browser.setWindowRect(20, 20, 1319, 799);
  await browser.setWindowRect(20, 20, 1320, 800);
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
        text: String(snapshot.text ?? ""),
      };
    }
  }, provider);
  return JSON.parse(serialized) as TerminalSnapshot | null;
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
      timeout: 90_000,
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
  for (const character of input) await browser.keys(character);
  await waitForProvider(provider, (snapshot) => snapshot.text.includes(input));
  await browser.keys("Enter");
  if (!(await waitForModelRequest(provider, input, 8_000))) {
    await browser.keys("Enter");
  }
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
