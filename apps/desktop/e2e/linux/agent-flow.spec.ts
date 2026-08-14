import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const fixtureRoot = process.env.CCSM_E2E_FIXTURE_ROOT;
if (!fixtureRoot) {
  throw new Error("CCSM_E2E_FIXTURE_ROOT must point to the Agent L4 fixture");
}

type Provider = "codex";

interface TerminalSnapshot {
  runtimeId: string | null;
  provider: Provider | "shell";
  bindingState: string | null;
  nativeSessionId: string | null;
  inputEnabled: boolean;
  text: string;
}

interface AgentUiState {
  activeName: string;
  agents: Array<{
    cliSessionId: string;
    spaceId: string;
    tabId: string;
    title: string;
    spaceName: string;
    activity: string;
    selected: boolean;
  }>;
  providerTabCount: number;
  providerPanelMounted: boolean;
}

interface ProcessRow {
  pid: number;
  parentPid: number;
  processGroupId: number;
  sessionId: number;
  state: string;
  command: string;
  argumentsText: string;
}

function processRows(): ProcessRow[] {
  return execFileSync(
    "ps",
    ["-eo", "pid=,ppid=,pgid=,sid=,stat=,comm=,args="],
    { encoding: "utf8" },
  )
    .split("\n")
    .flatMap((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/,
      );
      if (!match) return [];
      return [
        {
          pid: Number.parseInt(match[1], 10),
          parentPid: Number.parseInt(match[2], 10),
          processGroupId: Number.parseInt(match[3], 10),
          sessionId: Number.parseInt(match[4], 10),
          state: match[5],
          command: match[6],
          argumentsText: match[7] ?? "",
        },
      ];
    });
}

function descendantRows(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const processIds = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (processIds.has(row.parentPid) && !processIds.has(row.pid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => processIds.has(row.pid));
}

function testDesktop(rows: ProcessRow[]): ProcessRow | undefined {
  const appBinary = process.env.CCSM_E2E_APP_BINARY!;
  return rows.find(
    (row) =>
      row.command === "ccsm-desktop" &&
      (row.argumentsText === appBinary ||
        row.argumentsText.startsWith(`${appBinary} `)),
  );
}

function codexRuntimeProcessGroup(): number | null {
  const rows = processRows();
  const desktop = testDesktop(rows);
  if (!desktop) return null;
  const provider = descendantRows(rows, desktop.pid).find(
    (row) =>
      row.command === "codex" ||
      row.command.startsWith("codex-") ||
      row.argumentsText.includes("/usr/local/bin/codex") ||
      row.argumentsText.includes("@openai/codex"),
  );
  return provider?.processGroupId ?? null;
}

function rowsForProcessGroup(processGroupId: number): ProcessRow[] {
  return processRows().filter(
    (row) =>
      row.processGroupId === processGroupId ||
      row.argumentsText.includes(`process-watchdog ${processGroupId}`),
  );
}

function writeProcessRows(name: string, rows: ProcessRow[]): void {
  writeFileSync(
    join(artifactDirectory, name),
    `${[
      "PID PPID PGID SID STAT COMMAND ARGS",
      ...rows.map(
        (row) =>
          `${row.pid} ${row.parentPid} ${row.processGroupId} ${row.sessionId} ${row.state} ${row.command} ${row.argumentsText}`,
      ),
    ].join("\n")}\n`,
  );
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

async function agentUiState(): Promise<AgentUiState> {
  return browser.execute(() => {
    const providerPanels = Array.from(
      document.querySelectorAll<HTMLElement>(".terminal-panel"),
    ).filter((panel) => {
      const debug = (
        panel as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      return debug?.provider === "codex";
    });
    return {
      activeName:
        document.querySelector("#active-space-name")?.textContent ?? "",
      agents: Array.from(
        document.querySelectorAll<HTMLElement>(".agent-item"),
        (agent) => ({
          cliSessionId: agent.dataset.cliSessionId ?? "",
          spaceId: agent.dataset.spaceId ?? "",
          tabId: agent.dataset.tabId ?? "",
          title:
            agent.querySelector(".agent-item-labels > :first-child")
              ?.textContent ?? "",
          spaceName:
            agent.querySelector(".agent-item-labels > :nth-child(2)")
              ?.textContent ?? "",
          activity: agent.dataset.activity ?? "",
          selected: agent.dataset.foreground === "true",
        }),
      ),
      providerTabCount: Array.from(
        document.querySelectorAll<HTMLElement>(
          ".ccsm-tab[data-tab-kind='cli-session']",
        ),
      ).filter(
        (tab) => tab.querySelector(".ccsm-tab-label")?.textContent === "Codex",
      ).length,
      providerPanelMounted: providerPanels.length > 0,
    };
  });
}

async function openNewTabAction(action: Provider): Promise<void> {
  await browser.execute(() => {
    document.querySelector<HTMLButtonElement>(".dock-new-tab-button")?.click();
  });
  await $("#new-tab-menu").waitForDisplayed();
  expect(
    await browser.execute((requestedAction) => {
      const button = document.querySelector<HTMLButtonElement>(
        `#new-tab-menu button[data-new-tab-action='${requestedAction}']`,
      );
      button?.click();
      return Boolean(button);
    }, action),
  ).toBe(true);
}

async function createOtherSpace(): Promise<void> {
  await $("#new-space").click();
  const picker = await $(".directory-dialog");
  await picker.waitForDisplayed();
  await browser.execute((path) => {
    const input =
      document.querySelector<HTMLInputElement>(".directory-address");
    if (!input) throw new Error("directory address is missing");
    input.value = path;
    document
      .querySelector<HTMLFormElement>(".directory-address-form")
      ?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
  }, fixtureRoot);
  const useFolder = await $(".directory-use");
  await browser.waitUntil(async () => useFolder.isEnabled(), {
    timeout: 15_000,
    interval: 200,
    timeoutMsg: `${fixtureRoot} did not become selectable`,
  });
  await useFolder.click();
  const dialog = await $(".app-dialog");
  await dialog.waitForDisplayed();
  await $(".app-dialog-field input").setValue("Agent Other");
  await $("[data-dialog-action='submit']").click();
  await dialog.waitForDisplayed({ reverse: true });
  await browser.waitUntil(
    async () => (await agentUiState()).activeName === "Agent Other",
    { timeout: 30_000, timeoutMsg: "Agent Other Space did not activate" },
  );
}

async function requestCodexTabClose(): Promise<void> {
  expect(
    await browser.execute(() => {
      const tab = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".ccsm-tab[data-tab-kind='cli-session']",
        ),
      ).find(
        (candidate) =>
          candidate.querySelector(".ccsm-tab-label")?.textContent === "Codex",
      );
      const close = tab?.querySelector<HTMLButtonElement>(".ccsm-tab-close");
      close?.click();
      return Boolean(close);
    }),
  ).toBe(true);
  await $(".app-dialog").waitForDisplayed();
}

describe("Linux Agent workflow", () => {
  before(async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    mkdirSync(fixtureRoot, { recursive: true });
    await browser.pause(2_000);
    await $("#app").waitForDisplayed();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelector("#global-status")?.textContent === "ready",
        ),
      { timeout: 30_000, timeoutMsg: "initial Space did not become ready" },
    );
  });

  it("focuses an Agent across Spaces and protects Agent Tab deletion", async () => {
    const initialName = await browser.execute(
      () => document.querySelector("#active-space-name")?.textContent ?? "",
    );
    expect(initialName).not.toBe("");
    await openNewTabAction("codex");
    let started: TerminalSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        started = await terminalSnapshot("codex");
        return Boolean(
          started?.runtimeId &&
            started.inputEnabled &&
            started.text.length > 20,
        );
      },
      {
        timeout: 90_000,
        interval: 500,
        timeoutMsg: "Codex Agent runtime did not become interactive",
      },
    );
    await browser.waitUntil(
      async () => (await agentUiState()).agents.length === 1,
      { timeout: 15_000, timeoutMsg: "Codex Agent did not appear in sidebar" },
    );
    const runtimeId = started!.runtimeId;
    const initialAgentState = await agentUiState();
    expect(initialAgentState.agents[0]?.spaceName).toBe(initialName);
    await browser.waitUntil(() => codexRuntimeProcessGroup() !== null, {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "Codex runtime process group was not found",
    });
    const processGroupId = codexRuntimeProcessGroup()!;
    await browser.saveScreenshot(join(artifactDirectory, "agent-running.png"));

    await createOtherSpace();
    const inactiveState = await agentUiState();
    expect(inactiveState.agents).toHaveLength(1);
    expect(rowsForProcessGroup(processGroupId).length).toBeGreaterThan(0);
    await browser.saveScreenshot(
      join(artifactDirectory, "agent-from-other-space.png"),
    );

    expect(
      await browser.execute(() => {
        const agent = document.querySelector<HTMLButtonElement>(".agent-item");
        agent?.click();
        return Boolean(agent);
      }),
    ).toBe(true);
    await browser.waitUntil(
      async () => {
        const state = await agentUiState();
        const terminal = await terminalSnapshot("codex");
        return (
          state.activeName === initialName &&
          state.agents[0]?.selected === true &&
          terminal?.runtimeId === runtimeId &&
          terminal.inputEnabled
        );
      },
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "Agent click did not focus its Space and Tab",
      },
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "agent-cross-space-focused.png"),
    );

    writeProcessRows(
      "agent-processes-before-close.txt",
      rowsForProcessGroup(processGroupId),
    );

    await requestCodexTabClose();
    const dialog = await $(".app-dialog");
    expect(await $(".app-dialog-head h2").getText()).toContain(
      "Close Agent Tab",
    );
    const pendingClose = await agentUiState();
    expect(pendingClose.providerPanelMounted).toBe(true);
    expect(pendingClose.providerTabCount).toBe(1);
    expect(pendingClose.agents).toHaveLength(1);
    expect((await terminalSnapshot("codex"))?.runtimeId).toBe(runtimeId);
    await browser.saveScreenshot(
      join(artifactDirectory, "agent-close-confirmation.png"),
    );
    await $("[data-dialog-action='cancel']").click();
    await dialog.waitForDisplayed({ reverse: true });
    expect((await agentUiState()).agents).toHaveLength(1);
    expect((await terminalSnapshot("codex"))?.runtimeId).toBe(runtimeId);

    await requestCodexTabClose();
    await $("[data-dialog-action='close']").click();
    await dialog.waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () => {
        const state = await agentUiState();
        return (
          state.agents.length === 0 &&
          state.providerTabCount === 0 &&
          !state.providerPanelMounted
        );
      },
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "Agent Tab and sidebar record were not deleted",
      },
    );
    await browser.waitUntil(
      () => rowsForProcessGroup(processGroupId).length === 0,
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "Agent runtime process group remained after Tab deletion",
      },
    );
    writeProcessRows(
      "agent-processes-after-close.txt",
      rowsForProcessGroup(processGroupId),
    );
    const finalState = await agentUiState();
    writeFileSync(
      join(artifactDirectory, "agent-after-close.json"),
      `${JSON.stringify(
        { ...finalState, runtimeId, processGroupId },
        null,
        2,
      )}\n`,
    );
    await browser.saveScreenshot(join(artifactDirectory, "agent-closed.png"));
  });
});
