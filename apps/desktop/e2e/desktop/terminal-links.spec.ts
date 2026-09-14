import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ScenarioEvidence } from "./support/evidence";
import { readModelStubEvents, setModelResponse } from "./support/model-stub";

interface TerminalSnapshot {
  bindingState: string | null;
  bufferLength: number;
  cellHeight: number;
  cellWidth: number;
  cliSessionId: string | null;
  cols: number;
  inputEnabled: boolean;
  lastOutputRuntimeId: string | null;
  nativeSessionId: string | null;
  provider: "codex" | "shell";
  rows: number;
  runtimeId: string | null;
  scrollbackLength: number;
  text: string;
  viewportY: number;
}

interface TargetGeometry {
  cells: Array<{ col: number; row: number }>;
  endRow: number;
  startRow: number;
  x: number;
  y: number;
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const platform = requiredEnvironment("CCSM_E2E_PLATFORM");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const providerMarkdownScenarioId = "provider-markdown-links";
const terminalLinksScenarioId = "terminal-links";
const controlKey = "\uE009";
const provider = "codex" as const;

describe("Terminal links", () => {
  it("opens wrapped link and file path output from provider Markdown and tables", async () => {
    const scenarioId = providerMarkdownScenarioId;
    const evidence = new ScenarioEvidence(scenarioId);
    const spaceName = `E2E Provider Markdown ${runId}`;
    const spaceRoot = join(spaceRootBase, "links");
    const prompt = `render-provider-markdown-links-${runId}`;
    const browserUrl =
      "https://example.com/ccsm/e2e/windows-terminal-compatible/markdown/soft-wrapped/browser/link/target?source=terminal";
    const providerBrowserUrl = "https://example.com/p";
    const tableBrowserUrl =
      "https://example.com/ccsm/e2e/markdown/table/wrapped/browser/link/target?source=table";
    const relativeFilePath =
      "docs/e2e/windows-terminal-compatible/markdown/soft-wrapped/file/path/with/additional/review/context/target.md";
    const fileReference = `${relativeFilePath}:2:3`;
    const providerFilePath =
      "docs/e2e/markdown/table/wrapped/file/path/with/review/context/provider-click-target.md";
    const providerFileReference = `${providerFilePath}:2:3`;
    const heading = "Provider Markdown link regression";
    const tableHeading = "Nested target";
    const responseMarker = "CCSM_PROVIDER_MARKDOWN_RENDERED";
    const markdownResponse = [
      `## ${heading}`,
      "",
      `[${browserUrl}](${browserUrl})`,
      "",
      `\`${fileReference}\``,
      "",
      `[Open provider link](${providerBrowserUrl})`,
      "",
      `| ${tableHeading} | Link |`,
      "| --- | --- |",
      `| Table cell | [Open nested table link](${tableBrowserUrl}) |`,
      `| File cell | \`${providerFileReference}\` |`,
      "",
      responseMarker,
    ].join("\n");
    const targetPath = join(spaceRoot, ...relativeFilePath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "first line\nsecond line target\nthird line\n");
    mkdirSync(dirname(join(spaceRoot, providerFilePath)), { recursive: true });
    writeFileSync(
      join(spaceRoot, providerFilePath),
      "first line\nsecond line target\nthird line\n",
    );
    setModelResponse(provider, prompt, markdownResponse);

    let currentStep = "create-space";
    let primaryError: unknown;
    try {
      await restoreScenarioUi();
      await ensureProviderMarkdownWindow();
      currentStep = "reset-link-opening";
      await setDefaultBrowserLinkOpening(false);
      await createSpace(spaceName, spaceRoot);
      currentStep = "start-provider";
      await openProviderTab();
      await acknowledgeProviderStartup();
      const started = await waitForProvider((snapshot) =>
        Boolean(
          snapshot.runtimeId &&
            snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
            snapshot.inputEnabled &&
            terminalPromptReady(snapshot.text),
        ),
      );
      await waitForStablePrompt(started.runtimeId!);
      await evidence.checkpoint("provider-started");

      currentStep = "request-provider-markdown";
      await sendProviderLine(prompt);
      const output = await waitForProvider(
        (snapshot) =>
          textWithoutWhitespace(snapshot.text).includes(browserUrl) &&
          textWithoutWhitespace(snapshot.text).includes(fileReference) &&
          textWithoutWhitespace(snapshot.text).includes(providerBrowserUrl) &&
          textWithoutWhitespace(snapshot.text).includes(tableBrowserUrl) &&
          textWithoutWhitespace(snapshot.text).includes(
            providerFileReference,
          ) &&
          textWithoutWhitespace(snapshot.text).includes(
            textWithoutWhitespace(tableHeading),
          ) &&
          textWithoutWhitespace(snapshot.text).includes(responseMarker) &&
          terminalPromptReady(snapshot.text),
      );
      expect(output.cliSessionId).not.toBeNull();
      expect(output.runtimeId).not.toBeNull();
      await waitForAgentActivity(output.cliSessionId!, "idle");
      await waitForStablePrompt(output.runtimeId!);
      expect(
        readModelStubEvents(provider).some(
          (event) =>
            event.prompt === prompt && event.response === markdownResponse,
        ),
      ).toBe(true);
      const renderedText = textWithoutWhitespace(output.text);
      expect(renderedText).toContain(textWithoutWhitespace(heading));
      expect(renderedText).not.toContain(
        textWithoutWhitespace(`[${browserUrl}](${browserUrl})`),
      );
      expect(renderedText).not.toContain(
        textWithoutWhitespace(`\`${fileReference}\``),
      );
      expect(renderedText).not.toContain(
        textWithoutWhitespace(`[Open provider link](${providerBrowserUrl})`),
      );
      expect(renderedText).not.toContain(
        textWithoutWhitespace(`\`${providerFileReference}\``),
      );
      expect(renderedText).not.toContain("|---|---|");
      const minimized = await browser.execute(
        () => window.innerWidth < 900 || window.innerHeight < 650,
      );
      if (minimized) {
        await ensureProviderMarkdownWindow();
        await waitForStablePrompt(output.runtimeId!);
      }
      const viewport = await browser.execute(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      expect(viewport.width).toBeGreaterThanOrEqual(900);
      expect(viewport.height).toBeGreaterThanOrEqual(650);
      expect(output.cols).toBeLessThan(browserUrl.length);
      const browserGeometry = await targetGeometry(browserUrl, provider);
      expect(browserGeometry.endRow).toBeGreaterThan(browserGeometry.startRow);
      const fileGeometry = await targetGeometry(fileReference, provider);
      expect(fileGeometry.endRow).toBeGreaterThan(fileGeometry.startRow);
      await evidence.checkpoint("provider-markdown-rendered-and-wrapped");

      currentStep = "open-provider-wrapped-url";
      await movePointer(browserGeometry);
      await waitForLinkTooltip(browserUrl, provider);
      await controlClick(browserGeometry);
      await waitForBrowserUrl(browserUrl);
      await evidence.checkpoint("provider-wrapped-url-opened");
      await returnToProvider();

      currentStep = "open-provider-markdown-url";
      const providerBrowserTarget = await targetGeometry(
        providerBrowserUrl,
        provider,
        "optional",
      );
      await movePointer(providerBrowserTarget);
      await waitForLinkTooltip(providerBrowserUrl, provider);
      await controlClick(providerBrowserTarget);
      await waitForBrowserUrl(providerBrowserUrl);
      await evidence.checkpoint("provider-markdown-url-opened");

      currentStep = "open-provider-table-url";
      await returnToProvider();
      const tableBrowserTarget = await targetGeometry(
        tableBrowserUrl,
        provider,
        "required",
      );
      await movePointer(tableBrowserTarget);
      await waitForLinkTooltip(tableBrowserUrl, provider);
      await controlClick(tableBrowserTarget);
      await waitForBrowserUrl(tableBrowserUrl);
      await evidence.checkpoint("provider-table-url-opened");
      await returnToProvider();
      const tableUrlLast = await targetGeometry(
        tableBrowserUrl,
        provider,
        "required",
        "last",
      );
      await movePointer(tableUrlLast);
      await waitForLinkTooltip(tableBrowserUrl, provider);
      await controlClick(tableUrlLast);
      await waitForBrowserUrl(tableBrowserUrl);
      await evidence.checkpoint("provider-table-url-last-fragment-opened");

      currentStep = "open-provider-wrapped-file";
      await returnToProvider();
      const wrappedFileTarget = await targetGeometry(fileReference, provider);
      await movePointer(wrappedFileTarget);
      await waitForLinkTooltip(fileReference, provider);
      await controlClick(wrappedFileTarget);
      await waitForTab("file-editor", relativeFilePath);
      await browser.waitUntil(
        async () =>
          (await $(".file-editor-panel .file-editor-position").getText()) ===
          "Ln 2, Col 3",
        {
          timeout: 30_000,
          timeoutMsg: "Wrapped file did not reveal Ln 2, Col 3",
        },
      );
      await evidence.checkpoint("provider-wrapped-file-opened");

      currentStep = "open-provider-table-file";
      await returnToProvider();
      const providerFileTarget = await targetGeometry(
        providerFileReference,
        provider,
        "required",
      );
      await movePointer(providerFileTarget);
      await waitForLinkTooltip(providerFileReference, provider);
      await controlClick(providerFileTarget);
      const providerFileTab = await waitForTab("file-editor", providerFilePath);
      expect(await providerFileTab.getAttribute("title")).toBe(
        providerFilePath,
      );
      const providerEditor = await $(".file-editor-panel");
      await providerEditor.waitForDisplayed({ timeout: 30_000 });
      const providerPosition = await providerEditor.$(".file-editor-position");
      await browser.waitUntil(
        async () => (await providerPosition.getText()) === "Ln 2, Col 3",
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg:
            "Provider Markdown file link did not reveal line 2 column 3",
        },
      );
      await evidence.checkpoint("provider-table-file-opened");
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
        await stopProviderRuntime();
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

  it("opens wrapped link and file path output with Control-click", async () => {
    const scenarioId = terminalLinksScenarioId;
    const evidence = new ScenarioEvidence(scenarioId);
    const spaceName = `E2E Terminal Links ${runId}`;
    const spaceRoot = join(spaceRootBase, "terminal-links");
    const browserUrl =
      "https://example.com/ccsm/e2e/windows-terminal-compatible/soft-wrapped/browser/link/target?source=terminal";
    const relativeFilePath =
      "docs/e2e/windows-terminal-compatible/soft-wrapped/file/path/with/additional/review/context/target.md";
    const fileReference = `${relativeFilePath}:2:3`;
    const outputMarker = "CCSM_TERMINAL_LINK_CASE_END";
    const targetPath = join(spaceRoot, ...relativeFilePath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "first line\nsecond line target\nthird line\n");
    const scriptPath = writeOutputScript(spaceRoot, [
      "Terminal link regression",
      browserUrl,
      fileReference,
      outputMarker,
    ]);

    let currentStep = "create-space";
    let primaryError: unknown;
    try {
      await restoreScenarioUi();
      await ensureRenderableWindow();
      currentStep = "reset-link-opening";
      await setDefaultBrowserLinkOpening(false);
      await createSpace(spaceName, spaceRoot);
      await waitForShell((snapshot) =>
        Boolean(
          snapshot.runtimeId &&
            snapshot.lastOutputRuntimeId === snapshot.runtimeId &&
            snapshot.inputEnabled,
        ),
      );

      currentStep = "emit-terminal-links";
      const command =
        platform === "windows"
          ? `powershell -NoProfile -ExecutionPolicy Bypass -File .\\${scriptPath}`
          : `sh ./${scriptPath}`;
      await typeShellLine(command);
      const output = await waitForShell(
        (snapshot) =>
          textWithoutWhitespace(snapshot.text).includes(browserUrl) &&
          textWithoutWhitespace(snapshot.text).includes(fileReference) &&
          textWithoutWhitespace(snapshot.text).includes(outputMarker),
      );
      const viewport = await browser.execute(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      expect(viewport.width).toBeGreaterThanOrEqual(900);
      expect(viewport.height).toBeGreaterThanOrEqual(650);
      expect(output.cols).toBeLessThan(browserUrl.length);
      await evidence.checkpoint("terminal-links-wrapped");

      currentStep = "hover-wrapped-url";
      const browserTarget = await targetGeometry(browserUrl, "shell");
      expect(browserTarget.endRow).toBeGreaterThan(browserTarget.startRow);
      await movePointer(browserTarget);
      await waitForLinkTooltip(browserUrl, "shell");
      await verifyWholeLinkHover(browserTarget, browserUrl, "shell");
      await evidence.checkpoint("url-hover-tooltip");

      currentStep = "plain-click-keeps-link-closed";
      const browserCount = await browser.execute(
        () => document.querySelectorAll(".browser-panel").length,
      );
      await plainClick(browserTarget);
      await browser.pause(300);
      expect(
        await browser.execute(
          () => document.querySelectorAll(".browser-panel").length,
        ),
      ).toBe(browserCount);

      currentStep = "control-click-wrapped-url";
      const settledBrowserTarget = await targetGeometry(browserUrl, "shell");
      await movePointer(settledBrowserTarget);
      await waitForLinkTooltip(browserUrl, "shell");
      await controlClick(settledBrowserTarget);
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

      currentStep = "open-browser-tab-url-externally";
      const externalButton = await browserPanel.$(".browser-open-external");
      expect(await externalButton.getAttribute("aria-label")).toBe(
        "Open in default browser",
      );
      await externalButton.click();
      await browser.waitUntil(
        async () =>
          (await browserPanel.getAttribute("data-browser-status-message")) ===
          "opened in default browser",
        {
          timeout: 10_000,
          timeoutMsg: "Browser toolbar did not open the URL externally",
        },
      );
      await evidence.checkpoint("browser-url-opened-externally");

      currentStep = "return-to-shell";
      await clickTab("cli-session", "Shell");
      await $('.terminal-panel[data-provider="shell"]').waitForDisplayed({
        timeout: 20_000,
      });

      currentStep = "route-terminal-url-to-default-browser";
      await setDefaultBrowserLinkOpening(true);
      await clickTab("cli-session", "Shell");
      await focusTerminalInput("shell");
      const externalBrowserTarget = await targetGeometry(browserUrl, "shell");
      await movePointer(externalBrowserTarget);
      await waitForLinkTooltip(browserUrl, "shell");
      await controlClick(externalBrowserTarget);
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => document.querySelector("#global-status")?.textContent,
          )) === "opened link in default browser",
        {
          timeout: 10_000,
          timeoutMsg: "Terminal URL did not open in the default browser",
        },
      );
      expect(
        await browser.execute(
          () => document.querySelectorAll(".browser-panel").length,
        ),
      ).toBe(browserCount + 1);
      await evidence.checkpoint("terminal-url-opened-externally");
      await setDefaultBrowserLinkOpening(false);
      await clickTab("cli-session", "Shell");
      await $('.terminal-panel[data-provider="shell"]').waitForDisplayed({
        timeout: 20_000,
      });
      await focusTerminalInput("shell");

      currentStep = "hover-wrapped-file";
      const fileTarget = await targetGeometry(fileReference, "shell");
      expect(fileTarget.endRow).toBeGreaterThan(fileTarget.startRow);
      await movePointer(fileTarget);
      await waitForLinkTooltip(fileReference, "shell");
      await verifyWholeLinkHover(fileTarget, fileReference, "shell");
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

      // Preserve the exact plain-text manual report: hard CRLF, indentation,
      // table columns, and no ANSI styling to supply link boundaries.
      currentStep = "emit-unstyled-table-links";
      await clickTab("cli-session", "Shell");
      await ensureProviderMarkdownWindow();
      const tableUrl =
        "https://example.com/ccsm/manual/markdown/table/wrapped/browser/link/target?source=table";
      const tablePath =
        "docs/manual/wrapped-links/a-very-long-directory-name/with-several-levels/target.md";
      const tableFile = `${tablePath}:2:3`;
      mkdirSync(dirname(join(spaceRoot, tablePath)), { recursive: true });
      writeFileSync(
        join(spaceRoot, tablePath),
        "first line\nsecond line target\nthird line\n",
      );
      writeOutputScript(spaceRoot, [
        "\u001b[2J\u001b[H",
        "   Case          Target",
        "   ----------    --------------------------------------------------------",
        "   Browser       Open (https://example.com/ccsm/manual/",
        "                 markdown/table/wrapped/browser/link/target?",
        "                 source=table)",
        "   File          docs/manual/wrapped-links/a-very-long-directory-name/",
        "                 with-several-levels/target.md:2:3",
        "",
        "CCSM_UNSTYLED_TABLE_READY",
      ]);
      await typeShellLine(command);
      await waitForShell((snapshot) =>
        textWithoutWhitespace(snapshot.text).includes(
          "CCSM_UNSTYLED_TABLE_READY",
        ),
      );
      await evidence.checkpoint("unstyled-table-hard-wrap-rendered");
      for (const fragment of ["first", "continuation", "last"] as const) {
        currentStep = `open-unstyled-table-url-${fragment}`;
        await clickTab("cli-session", "Shell");
        await focusTerminalInput("shell");
        const target = await targetGeometry(
          tableUrl,
          "shell",
          "required",
          fragment,
          tableUrl.indexOf("markdown/table/"),
        );
        await movePointer(target);
        await waitForLinkTooltip(tableUrl, "shell");
        await verifyWholeLinkHover(target, tableUrl, "shell");
        await evidence.checkpoint(
          `unstyled-table-url-${fragment}-all-rows-hovered`,
        );
        await controlClick(target);
        await waitForBrowserUrl(tableUrl);
        await evidence.checkpoint(`unstyled-table-url-${fragment}-opened`);

        currentStep = `open-unstyled-table-file-${fragment}`;
        await clickTab("cli-session", "Shell");
        await focusTerminalInput("shell");
        const file = await targetGeometry(
          tableFile,
          "shell",
          "required",
          fragment,
          tableFile.indexOf("with-several-levels/"),
        );
        await movePointer(file);
        await waitForLinkTooltip(tableFile, "shell");
        await verifyWholeLinkHover(file, tableFile, "shell");
        await evidence.checkpoint(
          `unstyled-table-file-${fragment}-all-rows-hovered`,
        );
        await controlClick(file);
        await waitForTab("file-editor", tablePath);
        const tableEditor = await $(".file-editor-panel");
        await tableEditor.waitForDisplayed({ timeout: 30_000 });
        await browser.waitUntil(
          async () =>
            (await tableEditor.$(".file-editor-position").getText()) ===
            "Ln 2, Col 3",
          {
            timeout: 30_000,
            timeoutMsg: `Unstyled table file ${fragment} did not reveal Ln 2, Col 3`,
          },
        );
        await evidence.checkpoint(`unstyled-table-file-${fragment}-opened`);
      }
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
        await setDefaultBrowserLinkOpening(false);
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

async function targetGeometry(
  target: string,
  selectedProvider: TerminalSnapshot["provider"],
  wrapping: "required" | "optional" = "required",
  fragment: "first" | "continuation" | "last" = "continuation",
  continuationOffset = 0,
): Promise<TargetGeometry> {
  const serialized = await browser.execute(
    (
      expected,
      requestedProvider,
      requestedWrapping,
      requestedFragment,
      requestedOffset,
    ) => {
      const panel = document.querySelector<HTMLElement>(
        `.terminal-panel[data-provider="${CSS.escape(requestedProvider)}"]`,
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
      if (!snapshot || !canvas) {
        throw new Error(`${requestedProvider} terminal is incomplete`);
      }

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
          const startColumn =
            row === first ? 0 : Math.max(0, line.search(/\S|$/u));
          for (let col = startColumn; col < line.length; col += 1) {
            combined += line[col];
            positions.push({ col, row });
          }
          const match = combined.indexOf(expected);
          if (match < 0) continue;
          const targetPositions = positions.slice(
            match,
            match + expected.length,
          );
          const start = targetPositions[0];
          const end = targetPositions.at(-1);
          const wrapped = targetPositions.find(
            (position) => position.row > start.row,
          );
          if (
            !start ||
            !end ||
            (requestedWrapping === "required" && !wrapped)
          ) {
            throw new Error(`Target ${expected} did not wrap`);
          }
          const pointer =
            requestedFragment === "first"
              ? start
              : requestedFragment === "last"
                ? end
                : requestedOffset > 0
                  ? targetPositions[requestedOffset]
                  : (wrapped ??
                    targetPositions[Math.floor(targetPositions.length / 2)]);
          if (!pointer) throw new Error(`Target ${expected} has no cells`);

          const firstBufferLine = Math.max(
            0,
            snapshot.bufferLength - lines.length,
          );
          const absoluteRow = firstBufferLine + pointer.row;
          const viewportRow =
            absoluteRow -
            snapshot.scrollbackLength +
            Math.floor(snapshot.viewportY);
          if (viewportRow < 0 || viewportRow >= snapshot.rows) {
            throw new Error(`Target ${expected} is outside the viewport`);
          }
          const rect = canvas.getBoundingClientRect();
          return JSON.stringify({
            cells: targetPositions.map((position) => ({
              col: position.col,
              row:
                firstBufferLine +
                position.row -
                snapshot.scrollbackLength +
                Math.floor(snapshot.viewportY),
            })),
            startRow: start.row,
            endRow: end.row,
            x: Math.round(rect.left + (pointer.col + 0.5) * snapshot.cellWidth),
            y: Math.round(rect.top + (viewportRow + 0.5) * snapshot.cellHeight),
          });
        }
      }
      throw new Error(`Target ${expected} is absent from terminal output`);
    },
    target,
    selectedProvider,
    wrapping,
    fragment,
    continuationOffset,
  );
  return JSON.parse(serialized) as TargetGeometry;
}

async function movePointer(
  target: Pick<TargetGeometry, "x" | "y">,
): Promise<void> {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: "viewport", x: target.x, y: target.y })
    .perform();
}

interface LinkHoverPixels {
  rows: number[];
  text: number[];
  padding: number[];
}

/** Compare actual Canvas cells by link row; the underline follows the font baseline. */
async function linkHoverPixels(
  target: TargetGeometry,
  provider: TerminalSnapshot["provider"],
): Promise<LinkHoverPixels> {
  return browser.execute(
    (cells, requestedProvider) => {
      const panel = document.querySelector<HTMLElement>(
        `.terminal-panel[data-provider="${requestedProvider}"]`,
      );
      const snapshot = (
        panel as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__();
      const canvas = panel?.querySelector<HTMLCanvasElement>(
        "canvas:not(.terminal-resize-snapshot)",
      );
      if (!canvas) throw new Error("Terminal Canvas is unavailable");
      // Read a detached copy so repeated pixel checks preserve the live
      // renderer's GPU/CPU rasterization mode and text antialiasing.
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas pixel capture is unavailable");
      context.drawImage(canvas, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const rowCells = new Map<number, Set<number>>();
      for (const cell of cells) {
        if (cell.row < 0 || cell.row >= snapshot.rows)
          throw new Error("Link hover sample is outside the viewport");
        const columns = rowCells.get(cell.row) ?? new Set<number>();
        columns.add(cell.col);
        rowCells.set(cell.row, columns);
      }
      const digest = (columns: number[], row: number) => {
        let hash = 2166136261;
        for (const column of columns) {
          // Stay inside each cell so fractional-DPI edge antialiasing remains
          // outside the adjacent-padding sample.
          const x = Math.ceil((column * snapshot.cellWidth + 1) * scaleX);
          const y = Math.round(row * snapshot.cellHeight * scaleY);
          const width = Math.max(
            1,
            Math.floor((snapshot.cellWidth - 2) * scaleX),
          );
          const height = Math.max(1, Math.floor(snapshot.cellHeight * scaleY));
          for (let dy = 0; dy < height; dy += 1) {
            const from = ((y + dy) * copy.width + x) * 4;
            for (const value of pixels.subarray(from, from + width * 4))
              hash = Math.imul(hash ^ value, 16777619) >>> 0;
          }
        }
        return hash;
      };
      const result: LinkHoverPixels = { rows: [], text: [], padding: [] };
      for (const [row, set] of rowCells) {
        const columns = [...set].sort((a, b) => a - b);
        result.rows.push(row);
        result.text.push(digest(columns, row));
        result.padding.push(
          digest(
            [columns[0] - 1, columns.at(-1)! + 1].filter(
              (column) => column >= 0 && column < snapshot.cols,
            ),
            row,
          ),
        );
      }
      return result;
    },
    target.cells,
    provider,
  );
}

async function verifyWholeLinkHover(
  target: TargetGeometry,
  expected: string,
  provider: TerminalSnapshot["provider"],
): Promise<void> {
  await movePointer(await terminalBlankPoint(provider));
  let baseline: LinkHoverPixels | undefined;
  await browser.waitUntil(
    async () => {
      const next = await linkHoverPixels(target, provider);
      const settled = JSON.stringify(next) === JSON.stringify(baseline);
      baseline = next;
      return settled;
    },
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: "Link Canvas baseline did not settle",
    },
  );
  expect(baseline!.rows.length).toBeGreaterThan(1);
  const hover = async () => {
    await movePointer(target);
    await waitForLinkTooltip(expected, provider);
    await browser.waitUntil(
      async () => {
        const painted = await linkHoverPixels(target, provider);
        return (
          painted.text.every((hash, index) => hash !== baseline!.text[index]) &&
          painted.padding.every(
            (hash, index) => hash === baseline!.padding[index],
          )
        );
      },
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `Every row of ${expected} must underline while table padding stays unchanged`,
      },
    );
  };
  await hover();
  await movePointer(await terminalBlankPoint(provider));
  await browser.waitUntil(
    async () =>
      JSON.stringify(await linkHoverPixels(target, provider)) ===
      JSON.stringify(baseline),
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: `Every underline of ${expected} must clear on mouse leave`,
    },
  );
  await hover();
}

async function focusTerminalInput(
  selectedProvider: TerminalSnapshot["provider"],
): Promise<void> {
  await plainClick(await terminalBlankPoint(selectedProvider));
  await browser.waitUntil(
    () =>
      browser.execute((requestedProvider) => {
        const panel = document.querySelector<HTMLElement>(
          `.terminal-panel[data-provider="${CSS.escape(requestedProvider)}"]`,
        );
        return Boolean(
          panel?.querySelector("textarea") === document.activeElement,
        );
      }, selectedProvider),
    {
      timeout: 10_000,
      timeoutMsg: `${selectedProvider} terminal input did not regain focus`,
    },
  );
}

async function terminalBlankPoint(
  selectedProvider: TerminalSnapshot["provider"],
): Promise<{ x: number; y: number }> {
  return browser.execute((requestedProvider) => {
    const panel = document.querySelector<HTMLElement>(
      `.terminal-panel[data-provider="${CSS.escape(requestedProvider)}"]`,
    );
    const canvas = panel?.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas)
      throw new Error(`Missing ${requestedProvider} terminal canvas`);
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(rect.right - 30),
      y: Math.round(rect.bottom - 10),
    };
  }, selectedProvider);
}

async function plainClick(
  target: Pick<TargetGeometry, "x" | "y">,
): Promise<void> {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: "viewport", x: target.x, y: target.y })
    .down("left")
    .up("left")
    .perform();
}

async function controlClick(target: TargetGeometry): Promise<void> {
  // Complete the modifier dispatch before the pointer gesture crosses from a
  // native Browser surface back into the terminal WebView.
  await browser.performActions([
    {
      type: "key",
      id: "terminal-link-keyboard",
      actions: [{ type: "keyDown", value: controlKey }],
    },
  ]);
  try {
    await browser.performActions([
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
        ],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
}

async function waitForLinkTooltip(
  expected: string,
  selectedProvider: TerminalSnapshot["provider"],
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (target, requestedProvider) => {
          const tooltip = document.querySelector<HTMLElement>(
            `.terminal-panel[data-provider="${CSS.escape(requestedProvider)}"] [data-ghostty-link-tooltip]`,
          );
          return Boolean(
            tooltip &&
              !tooltip.hidden &&
              tooltip.dataset.visible === "true" &&
              tooltip.textContent === target,
          );
        },
        expected,
        selectedProvider,
      ),
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

async function openProviderTab(): Promise<void> {
  await $(".dock-new-tab-button").click();
  const menu = await $("#new-tab-menu");
  await menu.waitForDisplayed();
  await $("#new-tab-menu [data-new-tab-action='codex']").click();
  await menu.waitForDisplayed({ reverse: true });
}

async function acknowledgeProviderStartup(): Promise<void> {
  const handled = new Set<string>();
  await browser.waitUntil(
    async () => {
      const snapshot = await providerSnapshot();
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
        await sendProviderKeys(prompt.keys);
        return false;
      }
      return Boolean(
        snapshot.inputEnabled && terminalPromptReady(snapshot.text),
      );
    },
    {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "Codex did not complete its real CLI startup flow",
    },
  );
}

async function sendProviderLine(input: string): Promise<void> {
  await waitForProvider(
    (snapshot) =>
      snapshot.inputEnabled &&
      Boolean(
        snapshot.runtimeId &&
          snapshot.lastOutputRuntimeId === snapshot.runtimeId,
      ),
  );
  const panel = await providerPanel();
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const character of input) await browser.keys(character);
  await waitForProvider((snapshot) =>
    textWithoutWhitespace(snapshot.text).includes(textWithoutWhitespace(input)),
  );
  await browser.keys("Enter");
  if (!(await waitForModelRequest(input, 8_000))) await browser.keys("Enter");
}

async function sendProviderKeys(keys: string[]): Promise<void> {
  const panel = await providerPanel();
  const terminalInput = await panel.$('textarea[aria-label="Terminal input"]');
  await terminalInput.waitForExist({ timeout: 20_000 });
  await terminalInput.click();
  for (const key of keys) await browser.keys(key);
}

async function waitForModelRequest(
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

async function waitForStablePrompt(runtimeId: string): Promise<void> {
  let previousTail = "";
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      const snapshot = await providerSnapshot();
      if (
        snapshot?.runtimeId !== runtimeId ||
        snapshot.lastOutputRuntimeId !== runtimeId ||
        !terminalPromptReady(snapshot.text)
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
      timeoutMsg: "Codex prompt did not stabilize",
    },
  );
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

async function returnToProvider(): Promise<void> {
  await clickTab("cli-session", "Codex");
  await $('.terminal-panel[data-provider="codex"]').waitForDisplayed({
    timeout: 20_000,
  });
  await focusTerminalInput(provider);
}

async function waitForBrowserUrl(expected: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const panel of await $$(".browser-panel")) {
        const address = await panel.$(".browser-address");
        if (
          (await panel.isDisplayed()) &&
          (await address.getValue()) === expected
        ) {
          return true;
        }
      }
      return false;
    },
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `Provider Markdown URL did not open ${expected}`,
    },
  );
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

async function waitForProvider(
  predicate: (snapshot: TerminalSnapshot) => boolean,
): Promise<TerminalSnapshot> {
  let latest: TerminalSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await providerSnapshot();
      if (latest) {
        writeFileSync(
          join(artifactDirectory, "codex-links-latest.json"),
          `${JSON.stringify(latest, null, 2)}\n`,
        );
      }
      return Boolean(latest && predicate(latest));
    },
    {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: "Codex did not reach the expected rendered Markdown state",
    },
  );
  return latest!;
}

async function providerSnapshot(): Promise<TerminalSnapshot | null> {
  const serialized = await browser.execute(() => {
    for (const element of document.querySelectorAll<HTMLElement>(
      '.terminal-panel[data-provider="codex"]',
    )) {
      const snapshot = (
        element as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      if (snapshot?.inputEnabled) return JSON.stringify(snapshot);
    }
    return JSON.stringify(null);
  });
  return JSON.parse(serialized) as TerminalSnapshot | null;
}

async function providerPanel() {
  const panel = await $('.terminal-panel[data-provider="codex"]');
  await panel.waitForDisplayed({ timeout: 20_000 });
  return panel;
}

async function stopProviderRuntime(): Promise<void> {
  const snapshot = await providerSnapshot();
  if (!snapshot?.runtimeId) return;
  await clickTab("cli-session", "Codex");
  const panel = await providerPanel();
  const action = await panel.$('[data-testid="terminal-runtime-action"]');
  await action.waitForDisplayed({ timeout: 20_000 });
  await action.waitForEnabled({ timeout: 20_000 });
  await action.click();
  await waitForProvider((latest) => !latest.runtimeId);
}

function terminalPromptReady(text: string): boolean {
  const symbols = ["›", ">"];
  const last = symbols
    .map((symbol) => ({ index: text.lastIndexOf(symbol), symbol }))
    .sort((left, right) => right.index - left.index)[0];
  if (!last || last.index < 0) return false;
  const after = text.slice(last.index + last.symbol.length);
  const firstLine = after.split("\n", 1)[0].replaceAll("\u00a0", " ").trim();
  return (
    text.includes("gpt-5.6-sol") && !firstLine.includes("render-provider-")
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

function textWithoutWhitespace(text: string): string {
  return text.replaceAll(/\s/gu, "");
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

async function setDefaultBrowserLinkOpening(enabled: boolean): Promise<void> {
  const settingsButton = await $('[data-testid="settings-button"]');
  await settingsButton.waitForClickable({ timeout: 20_000 });
  await settingsButton.click();
  const dialog = await $(".settings-dialog");
  await dialog.waitForDisplayed({ timeout: 20_000 });
  const toggle = await $('[data-settings-action="toggle-default-browser"]');
  const current = (await toggle.getAttribute("aria-checked")) === "true";
  if (current !== enabled) {
    await toggle.click();
    await browser.waitUntil(
      async () =>
        (await toggle.getAttribute("aria-checked")) === String(enabled),
      {
        timeout: 10_000,
        timeoutMsg: `Default browser link setting did not become ${enabled}`,
      },
    );
  }
  await $('[data-settings-action="close"]').click();
  await dialog.waitForDisplayed({ reverse: true, timeout: 20_000 });
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

async function ensureProviderMarkdownWindow(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.maximizeWindow();
    await browser.setWindowRect(20, 20, 1320, 850);
    await browser.pause(200);
    const viewport = await browser.execute(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    if (viewport.width >= 1_200 && viewport.height >= 740) return;
  }
  throw new Error("Desktop viewport did not reach the provider Markdown size");
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
