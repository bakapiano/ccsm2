import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function requiredEnvironment(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required${hint ? `; ${hint}` : ""}`);
  }
  return value;
}

const appBinary = requiredEnvironment(
  "CCSM_E2E_APP_BINARY",
  "run pnpm test:desktop:build first",
);
const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");

const logDirectory = join(artifactDirectory, "logs");
mkdirSync(logDirectory, { recursive: true });

interface ScenarioResult {
  scenarioId: string;
  title: string;
  fullTitle: string;
  state: "passed" | "failed";
  durationMs: number;
  failureStep?: string;
  error?: string;
}

const scenarioIds = new Map([
  ["creates a Space and resumes Claude", "claude-resume"],
  ["creates a Space and resumes Codex", "codex-resume"],
  ["creates a Space and resumes GHCP", "ghcp-resume"],
  ["edits and previews Markdown", "markdown-edit-preview"],
  ["collapses and expands the sidebar", "sidebar-collapse"],
  ["opens Settings and checks updates", "settings-update"],
  [
    "copies and pastes terminal text and interrupts with Control-C",
    "terminal-clipboard-interrupt",
  ],
]);
const scenarioTitles: Record<string, string> = {
  claude: "creates a Space and resumes Claude",
  codex: "creates a Space and resumes Codex",
  ghcp: "creates a Space and resumes GHCP",
  markdown: "edits and previews Markdown",
  sidebar: "collapses and expands the sidebar",
  settings: "opens Settings and checks updates",
  terminal: "copies and pastes terminal text and interrupts with Control-C",
};
const selectedScenario = process.env.CCSM_E2E_SCENARIO ?? "all";
if (selectedScenario !== "all" && !scenarioTitles[selectedScenario]) {
  throw new Error(
    `CCSM_E2E_SCENARIO must be one of all, claude, codex, ghcp, markdown, sidebar, settings, terminal; received ${selectedScenario}`,
  );
}

function failureContext(scenarioId: string): { failureStep?: string } {
  const path = join(artifactDirectory, `${scenarioId}-failure-context.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      failureStep?: string;
    };
  } catch {
    return {};
  }
}

function readScenarioResults(): ScenarioResult[] {
  try {
    return JSON.parse(
      readFileSync(join(artifactDirectory, "result.json"), "utf8"),
    ) as ScenarioResult[];
  } catch {
    return [];
  }
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/desktop/**/*.spec.ts"],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  services: [
    [
      "tauri",
      {
        appBinaryPath: appBinary,
        driverProvider: "embedded",
        autoDownloadEdgeDriver: true,
        autoInstallTauriDriver: false,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        windowLabel: "main",
        backendLogLevel: "debug",
        frontendLogLevel: "debug",
        startTimeout: 120_000,
        statusPollTimeout: 10_000,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    } as WebdriverIO.Capabilities,
  ],
  outputDir: logDirectory,
  logLevel: process.env.CCSM_E2E_DEBUG === "1" ? "debug" : "info",
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: [
    "spec",
    [
      "junit",
      {
        outputDir: artifactDirectory,
        outputFileFormat: () => "junit.xml",
      },
    ],
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
    ...(selectedScenario !== "all"
      ? { grep: scenarioTitles[selectedScenario] }
      : {}),
  },
  before: async () => {
    writeFileSync(
      join(artifactDirectory, "capabilities.json"),
      `${JSON.stringify(browser.capabilities, null, 2)}\n`,
    );
    await browser.maximizeWindow();
    await browser.setWindowRect(20, 20, 1320, 800);
    await $("#app").waitForDisplayed({ timeout: 60_000 });
  },
  afterTest: async (test, _context, result) => {
    const results = readScenarioResults();
    const scenarioId = scenarioIds.get(test.title) ?? "unknown-scenario";
    const context = result.error ? failureContext(scenarioId) : {};
    results.push({
      scenarioId,
      title: test.title,
      fullTitle: `${test.parent} ${test.title}`.trim(),
      state: result.passed ? "passed" : "failed",
      durationMs: result.duration,
      ...context,
      ...(result.error ? { error: result.error.message } : {}),
    });
    writeFileSync(
      join(artifactDirectory, "result.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    if (!result.passed) {
      const name = test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      try {
        await browser.saveScreenshot(
          join(artifactDirectory, `${name}-failure.png`),
        );
      } catch (error) {
        writeFileSync(
          join(artifactDirectory, `${name}-screenshot-error.txt`),
          `${String(error)}\n`,
        );
      }
    }
  },
};
