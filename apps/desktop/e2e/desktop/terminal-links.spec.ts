import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ScenarioEvidence } from "./support/evidence";

interface TerminalSnapshot {
  bufferLength: number;
  cellHeight: number;
  cellWidth: number;
  cols: number;
  inputEnabled: boolean;
  lastOutputRuntimeId: string | null;
  provider: "shell";
  rows: number;
  runtimeId: string | null;
  scrollbackLength: number;
  text: string;
  viewportY: number;
}

interface TargetGeometry {
  endRow: number;
  startRow: number;
  x: number;
  y: number;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const platform = requiredEnvironment("CCSM_E2E_PLATFORM");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const scenarioId = "terminal-links";
const controlKey = "\uE009";

describe("Terminal links", () => {
  it("opens soft-wrapped Markdown URL and file links with Control-click", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    const spaceName = `E2E Links ${runId}`;
    const spaceRoot = join(spaceRootBase, "links");
    const browserUrl =
      "https://example.com/ccsm/e2e/windows-terminal-compatible/markdown/soft-wrapped/browser/link/target?source=terminal";
    const relativeFilePath =
      "docs/e2e/windows-terminal-compatible/markdown/soft-wrapped/file/path/with/additional/review/context/target.md";
    const fileReference = `${relativeFilePath}:2:3`;
    const markdownLines = [
      "## Terminal link regression",
      `- [wrapped browser URL](${browserUrl})`,
      `- \`${fileReference}\``,
      "CCSM_TERMINAL_LINK_CASE_END",
    ];
    const targetPath = join(spaceRoot, ...relativeFilePath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "first line\nsecond line target\nthird line\n");
    mkdirSync(spaceRoot, { recursive: true });
    const scriptPath = writeOutputScript(spaceRoot, markdownLines);

    let currentStep = "create-space";
    let primaryError: unknown;
    try {
      await restoreScenarioUi();
      await ensureRenderableWindow();
      await createSpace(spaceName, spaceRoot);
      await waitForShell((snapshot) =>
        Boolean(
          snapshot.runtimeId &&
            snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
            snapshot.inputEnabled,
        ),
      );

      currentStep = "emit-markdown-links";
      const command =
        platform === "windows"
          ? `powershell -NoProfile -ExecutionPolicy Bypass -File .\\${scriptPath}`
          : `sh ./${scriptPath}`;
      await typeShellLine(command);
      const output = await waitForShell(
        (snapshot) =>
          physicalText(snapshot.text).includes(browserUrl) &&
          physicalText(snapshot.text).includes(fileReference) &&
          snapshot.text.includes("CCSM_TERMINAL_LINK_CASE_END"),
      );
      const viewport = await browser.execute(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      expect(viewport.width).toBeGreaterThanOrEqual(900);
      expect(viewport.height).toBeGreaterThanOrEqual(650);
      expect(output.cols).toBeLessThan(browserUrl.length);
      await evidence.checkpoint("markdown-links-wrapped");

      currentStep = "hover-wrapped-url";
      const browserTarget = await targetGeometry(browserUrl);
      expect(browserTarget.endRow).toBeGreaterThan(browserTarget.startRow);
      await movePointer(browserTarget);
      await waitForLinkTooltip(browserUrl);
      await evidence.checkpoint("url-hover-tooltip");

      currentStep = "plain-click-keeps-link-closed";
      const browserPanels = await $$(".browser-panel");
      const browserCount = await browserPanels.length;
      await plainClick(browserTarget);
      await browser.pause(300);
      expect(await (await $$(".browser-panel")).length).toBe(browserCount);

      currentStep = "control-click-wrapped-url";
      await movePointer(browserTarget);
      await waitForLinkTooltip(browserUrl);
      await controlClick(browserTarget);
      const browserPanel = await $(".browser-panel");
      await browserPanel.waitForDisplayed({ timeout: 30_000 });
      const address = await browserPanel.$(".browser-address");
      await browser.waitUntil(
        async () => (await address.getValue()) === browserUrl,
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg: "Wrapped terminal URL did not open in the Browser Tab",
        },
      );
      await evidence.checkpoint("wrapped-url-opened");

      currentStep = "return-to-shell";
      await clickTab("cli-session", "Shell");
      await $('.terminal-panel[data-provider="shell"]').waitForDisplayed({
        timeout: 20_000,
      });

      currentStep = "hover-wrapped-file";
      const fileTarget = await targetGeometry(fileReference);
      expect(fileTarget.endRow).toBeGreaterThan(fileTarget.startRow);
      await movePointer(fileTarget);
      await waitForLinkTooltip(fileReference);
      await evidence.checkpoint("file-hover-tooltip");

      currentStep = "control-click-wrapped-file";
      await controlClick(fileTarget);
      const fileTab = await waitForTab("file-editor", relativeFilePath);
      expect(await fileTab.getAttribute("title")).toBe(relativeFilePath);
      const editor = await $(".file-editor-panel");
      await editor.waitForDisplayed({ timeout: 30_000 });
      const position = await editor.$(".file-editor-position");
      await browser.waitUntil(
        async () => (await position.getText()) === "Ln 2, Col 3",
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg:
            "Wrapped terminal file link did not reveal line 2 column 3",
        },
      );
      await evidence.checkpoint("wrapped-file-opened");
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

function writeOutputScript(root: string, lines: string[]): string {
  if (platform === "windows") {
    const name = "emit-terminal-links.ps1";
    const body = [
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
      ...lines.map((line) => `Write-Output '${line.replaceAll("'", "''")}'`),
    ].join("\r\n");
    writeFileSync(join(root, name), `${body}\r\n`);
    return name;
  }

  const name = "emit-terminal-links.sh";
  const body = [
    "#!/bin/sh",
    ...lines.map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`),
  ].join("\n");
  writeFileSync(join(root, name), `${body}\n`);
  return name;
}

async function targetGeometry(target: string): Promise<TargetGeometry> {
  const serialized = await browser.execute((expected) => {
    const panel = document.querySelector<HTMLElement>(
      '.terminal-panel[data-provider="shell"]',
    );
    const snapshot = (
      panel as
        | (HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
          })
        | null
    )?.__CCSM_TERMINAL_DEBUG__?.();
    const canvas = panel?.querySelector<HTMLCanvasElement>(
      "canvas:not(.terminal-resize-snapshot)",
    );
    if (!snapshot || !canvas) throw new Error("Shell terminal is incomplete");

    const lines = snapshot.text.split("\n");
    for (let first = 0; first < lines.length; first += 1) {
      let combined = "";
      const positions: Array<{ col: number; row: number }> = [];
      for (
        let row = first;
        row < Math.min(lines.length, first + 12);
        row += 1
      ) {
        const line = lines[row];
        for (let col = 0; col < line.length; col += 1) {
          combined += line[col];
          positions.push({ col, row });
        }
        const match = combined.indexOf(expected);
        if (match < 0) continue;
        const targetPositions = positions.slice(match, match + expected.length);
        const start = targetPositions[0];
        const end = targetPositions.at(-1);
        const wrapped = targetPositions.find(
          (position) => position.row > start.row,
        );
        if (!start || !end || !wrapped) {
          throw new Error(`Target ${expected} did not soft-wrap`);
        }

        const firstBufferLine = Math.max(
          0,
          snapshot.bufferLength - lines.length,
        );
        const absoluteRow = firstBufferLine + wrapped.row;
        const viewportRow =
          absoluteRow -
          snapshot.scrollbackLength +
          Math.floor(snapshot.viewportY);
        if (viewportRow < 0 || viewportRow >= snapshot.rows) {
          throw new Error(`Target ${expected} is outside the viewport`);
        }
        const rect = canvas.getBoundingClientRect();
        return JSON.stringify({
          startRow: start.row,
          endRow: end.row,
          x: Math.round(rect.left + (wrapped.col + 0.5) * snapshot.cellWidth),
          y: Math.round(rect.top + (viewportRow + 0.5) * snapshot.cellHeight),
        });
      }
    }
    throw new Error(`Target ${expected} is absent from terminal output`);
  }, target);
  return JSON.parse(serialized) as TargetGeometry;
}

async function movePointer(target: TargetGeometry): Promise<void> {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: "viewport", x: target.x, y: target.y })
    .perform();
}

async function plainClick(target: TargetGeometry): Promise<void> {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: "viewport", x: target.x, y: target.y })
    .down("left")
    .up("left")
    .perform();
}

async function controlClick(target: TargetGeometry): Promise<void> {
  await browser.performActions([
    {
      type: "key",
      id: "terminal-link-keyboard",
      actions: [
        { type: "keyDown", value: controlKey },
        { type: "pause", duration: 0 },
        { type: "pause", duration: 0 },
        { type: "keyUp", value: controlKey },
      ],
    },
    {
      type: "pointer",
      id: "terminal-link-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: target.x,
          y: target.y,
        },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
        { type: "pause", duration: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function waitForLinkTooltip(expected: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((target) => {
        const tooltip = document.querySelector<HTMLElement>(
          '.terminal-panel[data-provider="shell"] [data-ghostty-link-tooltip]',
        );
        return Boolean(
          tooltip &&
            !tooltip.hidden &&
            tooltip.dataset.visible === "true" &&
            tooltip.textContent?.includes(target),
        );
      }, expected),
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `Terminal link tooltip did not show ${expected}`,
    },
  );
}

async function typeShellLine(input: string): Promise<void> {
  const panel = await $('.terminal-panel[data-provider="shell"]');
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const character of input) await browser.keys(character);
  await browser.keys("Enter");
}

async function clickTab(kind: string, label: string): Promise<void> {
  const tabs = await $$(`.ccsm-tab[data-tab-kind="${kind}"]`);
  for (const tab of tabs) {
    if ((await tab.getText()).includes(label)) {
      await tab.click();
      return;
    }
  }
  throw new Error(`${label} ${kind} tab is absent`);
}

async function waitForTab(kind: string, title: string) {
  let match: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const tab of await $$(`.ccsm-tab[data-tab-kind="${kind}"]`)) {
        if ((await tab.getAttribute("title")) === title) {
          match = tab;
          return true;
        }
      }
      return false;
    },
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `${title} ${kind} tab did not open`,
    },
  );
  return match!;
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
      timeoutMsg: "Shell terminal did not reach the expected link state",
    },
  );
  return latest!;
}

async function shellSnapshot(): Promise<TerminalSnapshot | null> {
  const serialized = await browser.execute(() => {
    const element = document.querySelector<HTMLElement>(
      '.terminal-panel[data-provider="shell"]',
    );
    return JSON.stringify(
      (
        element as
          | (HTMLElement & {
              __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
            })
          | null
      )?.__CCSM_TERMINAL_DEBUG__?.() ?? null,
    );
  });
  return JSON.parse(serialized) as TerminalSnapshot | null;
}

function physicalText(text: string): string {
  return text.replaceAll("\n", "");
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

async function ensureRenderableWindow(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.maximizeWindow();
    await browser.setWindowRect(20, 20, 980, 760);
    await browser.pause(200);
    const viewport = await browser.execute(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    if (viewport.width >= 900 && viewport.height >= 650) return;
  }
  throw new Error("Desktop viewport did not reach a renderable link-test size");
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
