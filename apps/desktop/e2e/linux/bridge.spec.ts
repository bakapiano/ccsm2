import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const credentialedProviderSmoke = process.env.CCSM_E2E_REAL_PROVIDERS === "1";
const skipBrowserSmoke = process.env.CCSM_E2E_SKIP_BROWSER === "1";
const abnormalExitSmoke = process.env.CCSM_E2E_ABNORMAL_EXIT === "1";
const requestedProviders = new Set(
  (process.env.CCSM_E2E_PROVIDERS ?? "claude,codex,copilot")
    .split(",")
    .map((provider) => provider.trim()),
);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

type Provider = "claude" | "codex" | "copilot";
type TerminalProvider = Provider | "shell";

interface TerminalSnapshot {
  runtimeId: string | null;
  provider: TerminalProvider;
  bindingState: string | null;
  nativeSessionId: string | null;
  inputEnabled: boolean;
  text: string;
}

async function openNewTabAction(action: string): Promise<void> {
  await browser.execute(() => {
    document.querySelector<HTMLButtonElement>(".dock-new-tab-button")?.click();
  });
  const menu = await $("#new-tab-menu");
  await menu.waitForDisplayed();
  await browser.execute((requestedAction) => {
    document
      .querySelector<HTMLButtonElement>(
        `#new-tab-menu button[data-new-tab-action="${requestedAction}"]`,
      )
      ?.click();
  }, action);
}

async function terminalSnapshot(
  provider: TerminalProvider,
): Promise<TerminalSnapshot | null> {
  return browser.execute((requestedProvider) => {
    let fallback: TerminalSnapshot | null = null;
    const elements = document.querySelectorAll<HTMLElement>(".terminal-panel");
    for (const element of elements) {
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

async function focusTerminal(provider: TerminalProvider): Promise<void> {
  const focused = await browser.execute((requestedProvider) => {
    const elements = document.querySelectorAll<HTMLElement>(".terminal-panel");
    for (const element of elements) {
      const debug = (
        element as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      if (debug?.provider !== requestedProvider || !debug.inputEnabled)
        continue;
      const textarea = element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Terminal input"]',
      );
      textarea?.focus();
      return document.activeElement === textarea;
    }
    return false;
  }, provider);
  expect(focused).toBe(true);
}

async function dispatchTerminalKey(
  provider: TerminalProvider,
  init: KeyboardEventInit,
): Promise<boolean> {
  return browser.execute(
    (requestedProvider, eventInit) => {
      const elements =
        document.querySelectorAll<HTMLElement>(".terminal-panel");
      for (const element of elements) {
        const debug = (
          element as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.();
        if (debug?.provider !== requestedProvider || !debug.inputEnabled)
          continue;
        const host = element.querySelector<HTMLElement>(".terminal-host");
        if (!host) return false;
        return !host.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...eventInit,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return false;
    },
    provider,
    init,
  );
}

async function pasteTerminalText(
  provider: TerminalProvider,
  input: string,
): Promise<boolean> {
  return browser.execute(
    (requestedProvider, pastedText) => {
      const elements =
        document.querySelectorAll<HTMLElement>(".terminal-panel");
      for (const element of elements) {
        const debug = (
          element as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.();
        if (debug?.provider !== requestedProvider || !debug.inputEnabled)
          continue;
        const host = element.querySelector<HTMLElement>(".terminal-host");
        if (!host) return false;
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", pastedText);
        return !host.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      }
      return false;
    },
    provider,
    input,
  );
}

async function sendTerminalLine(
  provider: Provider,
  line: string,
): Promise<void> {
  const escapedLine = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const submittedPattern =
    provider === "copilot"
      ? new RegExp(`${escapedLine}\\s+\\d{1,2}:\\d{2}(?:\\s|$)`)
      : new RegExp(
          `(?:^|\\n)${provider === "codex" ? "›" : "❯"}\\s+${escapedLine}(?:\\s|$)`,
        );
  const attempts = provider === "claude" ? 1 : 3;
  await focusTerminal(provider);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt === 0 || provider === "codex") {
      if (attempt > 0) {
        const clearHandled = await dispatchTerminalKey(provider, {
          key: "u",
          code: "KeyU",
          ctrlKey: true,
        });
        expect(clearHandled).toBe(true);
        await browser.pause(100);
      }
      const pasteHandled = await pasteTerminalText(provider, line);
      expect(pasteHandled).toBe(true);
      await browser.pause(150);
    }
    const enterHandled = await dispatchTerminalKey(provider, {
      key: "Enter",
      code: "Enter",
    });
    expect(enterHandled).toBe(true);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const snapshot = await terminalSnapshot(provider);
      if (snapshot && submittedPattern.test(snapshot.text)) return;
      await browser.pause(250);
    }
    await focusTerminal(provider);
  }
  throw new Error(`${provider} did not submit terminal line: ${line}`);
}

async function waitForProvider(
  provider: TerminalProvider,
  predicate: (snapshot: TerminalSnapshot) => boolean,
  timeout = 180_000,
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
      interval: 1_000,
      timeoutMsg: `${provider} did not reach the expected terminal state`,
    },
  );
  return latest!;
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

function writeProcessEvidence(name: string): void {
  const processes = execFileSync(
    "ps",
    ["-eo", "pid,ppid,pgid,sid,stat,comm,args", "--forest"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) =>
      /ccsm-desktop|ccsm-provider|claude|codex|copilot|WebKit|tauri-driver/.test(
        line,
      ),
    )
    .join("\n");
  writeFileSync(join(artifactDirectory, name), `${processes}\n`);
}

function providerProcessGroup(provider: Provider): number | null {
  for (const line of execFileSync("ps", ["-eo", "pgid=,comm=,args="], {
    encoding: "utf8",
  }).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const command = match[2];
    const argumentsText = match[3];
    if (
      command === provider ||
      command.startsWith(`${provider}-`) ||
      argumentsText.includes(`/usr/local/bin/${provider}`) ||
      (provider === "copilot" && argumentsText.includes("@github/copilot"))
    ) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function lingeringRuntimeProcesses(
  provider: Provider,
  processGroups: number[],
): string[] {
  return execFileSync("ps", ["-eo", "comm=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => {
      const command = line.trimStart().split(/\s+/, 1)[0] ?? "";
      return (
        command === provider ||
        command.startsWith(`${provider}-`) ||
        processGroups.some((pgid) => line.includes(` process-watchdog ${pgid}`))
      );
    });
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

function writeProcessRows(name: string, rows: ProcessRow[]): void {
  const lines = [
    "PID PPID PGID SID STAT COMMAND ARGS",
    ...rows.map(
      (row) =>
        `${row.pid} ${row.parentPid} ${row.processGroupId} ${row.sessionId} ${row.state} ${row.command} ${row.argumentsText}`,
    ),
  ];
  writeFileSync(join(artifactDirectory, name), `${lines.join("\n")}\n`);
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

function watchdogProcessGroups(rows: ProcessRow[]): number[] {
  return rows.flatMap((row) => {
    if (row.command !== "ccsm-desktop") return [];
    const match = row.argumentsText.match(/\bprocess-watchdog (\d+)\b/);
    return match ? [Number.parseInt(match[1], 10)] : [];
  });
}

function desktopProcess(rows: ProcessRow[]): ProcessRow | undefined {
  const appBinary = process.env.CCSM_E2E_APP_BINARY!;
  return rows.find(
    (row) =>
      row.command === "ccsm-desktop" &&
      (row.argumentsText === appBinary ||
        row.argumentsText.startsWith(`${appBinary} `)),
  );
}

async function waitForProcessState(
  predicate: () => boolean,
  timeout: number,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(timeoutMessage);
}

describe("Linux Tauri WebView bridge", () => {
  before(async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    await browser.pause(2_000);
    await $("#app").waitForDisplayed();
  });

  (skipBrowserSmoke ? it.skip : it)(
    "drives the real renderer and opens the New Tab menu",
    async () => {
      await browser.saveScreenshot(
        join(artifactDirectory, "bridge-baseline.png"),
      );

      const newTab = await $(".dock-new-tab-button");
      await newTab.waitForClickable();
      await browser.execute(() => {
        document
          .querySelector<HTMLButtonElement>(".dock-new-tab-button")
          ?.click();
      });

      const menu = await $("#new-tab-menu");
      await menu.waitForDisplayed();
      const labels = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "#new-tab-menu button[data-new-tab-action]",
          ),
          (button) => button.textContent ?? "",
        ),
      );
      expect(labels).toEqual([
        "Shell",
        "Claude Code",
        "Codex",
        "GitHub Copilot",
        "Browser",
        "File Explorer",
        "Git",
      ]);

      await browser.saveScreenshot(
        join(artifactDirectory, "bridge-new-tab-menu.png"),
      );

      await browser.execute(() => {
        document
          .querySelector<HTMLButtonElement>(".dock-new-tab-button")
          ?.click();
      });
      await menu.waitForDisplayed({ reverse: true });
      const anchor = await $(".browser-anchor");
      await anchor.waitForDisplayed();
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            Array.from(document.querySelectorAll(".browser-state")).some(
              (state) => state.textContent?.includes("ready"),
            ),
          ),
        {
          timeout: 30_000,
          timeoutMsg: "WebKitGTK Browser did not become ready",
        },
      );
      const geometry = await browser.execute(() => {
        const rect = document
          .querySelector<HTMLElement>(".browser-anchor")!
          .getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          browserAnchor: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      });
      writeFileSync(
        join(artifactDirectory, "renderer-geometry.json"),
        `${JSON.stringify(geometry, null, 2)}\n`,
      );
      await browser.pause(2_000);
      captureWslgWindow("browser-live.png");

      await browser.execute(() => {
        document
          .querySelector<HTMLButtonElement>(".dock-new-tab-button")
          ?.click();
      });
      await menu.waitForDisplayed();
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const anchor =
              document.querySelector<HTMLElement>(".browser-anchor");
            const image =
              anchor?.querySelector<HTMLImageElement>(".browser-snapshot");
            return (
              anchor?.dataset.snapshotVisible === "true" &&
              image?.src.startsWith("data:image/png;base64,")
            );
          }),
        {
          timeout: 15_000,
          timeoutMsg: "WebKitGTK overlay snapshot was not presented",
        },
      );
      await browser.saveScreenshot(
        join(artifactDirectory, "browser-overlay.png"),
      );
      captureWslgWindow("browser-overlay-composited.png");
      await browser.execute(() => {
        document
          .querySelector<HTMLButtonElement>(".dock-new-tab-button")
          ?.click();
      });
      await menu.waitForDisplayed({ reverse: true });
    },
  );

  for (const provider of ["claude", "codex", "copilot"] as const) {
    (credentialedProviderSmoke && requestedProviders.has(provider)
      ? it
      : it.skip)(
      `${provider} completes a GUI turn and resumes the same native session`,
      async () => {
        await openNewTabAction(provider);
        const started = await waitForProvider(
          provider,
          (snapshot) =>
            Boolean(
              snapshot.runtimeId &&
                snapshot.inputEnabled &&
                snapshot.text.length > 100 &&
                (provider !== "claude" ||
                  (snapshot.bindingState === "bound" &&
                    snapshot.nativeSessionId)),
            ),
          60_000,
        );
        const firstRuntimeId = started.runtimeId;
        const turnOne = `CCSM_LINUX_${provider.toUpperCase()}_TURN1`;
        await browser.pause(1_500);
        await sendTerminalLine(provider, `Reply with exactly ${turnOne}`);
        const firstReply = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.split(turnOne).length >= 3 &&
            Boolean(snapshot.nativeSessionId) &&
            snapshot.bindingState === "bound",
        );
        const nativeSessionId = firstReply.nativeSessionId;
        const firstProcessGroup = providerProcessGroup(provider);
        expect(firstProcessGroup).not.toBeNull();
        await browser.saveScreenshot(
          join(artifactDirectory, `${provider}-turn1.png`),
        );
        writeProcessEvidence(`${provider}-processes-turn1.txt`);

        await browser.execute((requestedProvider) => {
          for (const element of document.querySelectorAll<HTMLElement>(
            ".terminal-panel",
          )) {
            const debug = (
              element as HTMLElement & {
                __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
              }
            ).__CCSM_TERMINAL_DEBUG__?.();
            if (debug?.provider === requestedProvider) {
              element
                .querySelector<HTMLButtonElement>(".terminal-action")
                ?.click();
              return;
            }
          }
        }, provider);
        await waitForProvider(
          provider,
          (snapshot) => !snapshot.runtimeId,
          30_000,
        );

        await browser.execute((requestedProvider) => {
          for (const element of document.querySelectorAll<HTMLElement>(
            ".terminal-panel",
          )) {
            const debug = (
              element as HTMLElement & {
                __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
              }
            ).__CCSM_TERMINAL_DEBUG__?.();
            if (debug?.provider === requestedProvider) {
              element
                .querySelector<HTMLButtonElement>(".terminal-action")
                ?.click();
              return;
            }
          }
        }, provider);
        const resumed = await waitForProvider(
          provider,
          (snapshot) =>
            Boolean(
              snapshot.runtimeId && snapshot.runtimeId !== firstRuntimeId,
            ),
          60_000,
        );
        expect(resumed.nativeSessionId).toBe(nativeSessionId);
        await browser.waitUntil(() => providerProcessGroup(provider) !== null, {
          timeout: 30_000,
          interval: 250,
          timeoutMsg: `${provider} resume process group did not start`,
        });
        const resumedProcessGroup = providerProcessGroup(provider);
        expect(resumedProcessGroup).not.toBeNull();
        await browser.pause(1_500);

        const turnTwo = `CCSM_LINUX_${provider.toUpperCase()}_TURN2`;
        await sendTerminalLine(provider, `Reply with exactly ${turnTwo}`);
        const secondReply = await waitForProvider(
          provider,
          (snapshot) =>
            snapshot.text.split(turnTwo).length >= 3 &&
            snapshot.nativeSessionId === nativeSessionId,
        );
        expect(secondReply.runtimeId).not.toBe(firstRuntimeId);
        await browser.saveScreenshot(
          join(artifactDirectory, `${provider}-resume-turn2.png`),
        );
        writeProcessEvidence(`${provider}-processes-resumed.txt`);

        await browser.execute((requestedProvider) => {
          for (const element of document.querySelectorAll<HTMLElement>(
            ".terminal-panel",
          )) {
            const debug = (
              element as HTMLElement & {
                __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
              }
            ).__CCSM_TERMINAL_DEBUG__?.();
            if (debug?.provider === requestedProvider) {
              element
                .querySelector<HTMLButtonElement>(".terminal-action")
                ?.click();
              return;
            }
          }
        }, provider);
        await waitForProvider(
          provider,
          (snapshot) => !snapshot.runtimeId,
          30_000,
        );
        const processGroups = [firstProcessGroup, resumedProcessGroup].filter(
          (pgid): pgid is number => pgid !== null,
        );
        await browser.waitUntil(
          () => lingeringRuntimeProcesses(provider, processGroups).length === 0,
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: `${provider} process group or watchdog remained after Stop`,
          },
        );
        writeProcessEvidence(`${provider}-processes-stopped.txt`);
        expect(lingeringRuntimeProcesses(provider, processGroups)).toEqual([]);
      },
    );
  }

  (abnormalExitSmoke ? it : it.skip)(
    "releases the runtime process group after desktop SIGKILL",
    async () => {
      await openNewTabAction("shell");
      const shell = await waitForProvider(
        "shell",
        (snapshot) =>
          Boolean(
            snapshot.runtimeId &&
              snapshot.inputEnabled &&
              snapshot.text.includes("$"),
          ),
        30_000,
      );

      await waitForProcessState(
        () => watchdogProcessGroups(processRows()).length > 0,
        30_000,
        "Shell runtime watchdog did not expose a process group",
      );

      expect(await pasteTerminalText("shell", "sleep 600")).toBe(true);
      await browser.pause(150);
      expect(
        await dispatchTerminalKey("shell", { key: "Enter", code: "Enter" }),
      ).toBe(true);
      await browser.pause(500);
      writeFileSync(
        join(artifactDirectory, "shell-after-command.json"),
        `${JSON.stringify(await terminalSnapshot("shell"), null, 2)}\n`,
      );
      const before = processRows();
      const desktop = desktopProcess(before);
      expect(desktop).toBeDefined();
      const runtimeProcessGroups = watchdogProcessGroups(before);
      expect(runtimeProcessGroups.length).toBeGreaterThan(0);
      const desktopProcessIds = new Set(
        descendantRows(before, desktop!.pid).map((row) => row.pid),
      );
      const recordedRows = before.filter(
        (row) =>
          desktopProcessIds.has(row.pid) ||
          runtimeProcessGroups.includes(row.processGroupId),
      );
      const recordedProcessIds = new Set(recordedRows.map((row) => row.pid));
      writeProcessRows("abnormal-exit-before-sigkill.txt", recordedRows);
      writeFileSync(
        join(artifactDirectory, "abnormal-exit-identities.json"),
        `${JSON.stringify(
          {
            runtimeId: shell.runtimeId,
            desktopPid: desktop!.pid,
            runtimeProcessGroups,
            recordedProcessIds: [...recordedProcessIds].sort((a, b) => a - b),
          },
          null,
          2,
        )}\n`,
      );

      execFileSync("kill", ["-KILL", String(desktop!.pid)]);
      await waitForProcessState(
        () => {
          const rows = processRows();
          const remainingWatchdogs = watchdogProcessGroups(rows);
          return (
            rows.every((row) => !recordedProcessIds.has(row.pid)) &&
            rows.every(
              (row) => !runtimeProcessGroups.includes(row.processGroupId),
            ) &&
            runtimeProcessGroups.every(
              (group) => !remainingWatchdogs.includes(group),
            )
          );
        },
        15_000,
        "desktop descendants, runtime group, or watchdog remained after SIGKILL",
      );

      const after = processRows().filter(
        (row) =>
          recordedProcessIds.has(row.pid) ||
          runtimeProcessGroups.includes(row.processGroupId) ||
          runtimeProcessGroups.some((group) =>
            row.argumentsText.includes(`process-watchdog ${group}`),
          ),
      );
      writeProcessRows("abnormal-exit-after-sigkill.txt", after);
      writeFileSync(
        join(artifactDirectory, "abnormal-exit-result.txt"),
        "PASS: desktop SIGKILL released every recorded descendant, runtime process group, and watchdog\n",
      );
      expect(after).toEqual([]);
    },
  );
});
