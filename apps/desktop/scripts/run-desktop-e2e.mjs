import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const platform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
const runId =
  process.env.CCSM_E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid}`;
const runMode = process.argv.includes("--ci")
  ? "ci"
  : process.argv.includes("--debug")
    ? "debug"
    : process.argv.includes("--evidence")
      ? "evidence"
      : "local";
const selectedScenario = process.env.CCSM_E2E_SCENARIO ?? "all";
const ownArguments = new Set(["--ci", "--debug", "--evidence"]);
const wdioArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--" && !ownArguments.has(argument));
const plannedScenarioIds = expectedScenarioIds(selectedScenario, wdioArguments);
const usesProviderHarness = plannedScenarioIds.some(
  (scenarioId) => scenarioId !== "markdown-edit-preview",
);
const artifactDirectory = resolve(
  process.env.CCSM_E2E_ARTIFACT_DIR ??
    join(repositoryRoot, "test-results", "desktop", platform, runId),
);
const runtimeRootParent = resolve(
  process.env.CCSM_E2E_RUNTIME_PARENT ??
    join(repositoryRoot, "..", ".ccsm-e2e-runtime"),
);
mkdirSync(runtimeRootParent, { recursive: true });
const temporaryRoot = mkdtempSync(
  join(runtimeRootParent, `.ccsm-e2e-${platform}-`),
);
const binaryName =
  process.platform === "win32" ? "ccsm-desktop.exe" : "ccsm-desktop";
const sourceAppBinary = resolve(
  process.env.CCSM_E2E_APP_BINARY ??
    join(repositoryRoot, "target", "debug", binaryName),
);
const appBinary = sourceAppBinary;
const modelStubConfigFile = join(temporaryRoot, "model-stub.json");
const modelStubLog = join(artifactDirectory, "logs", "model-stub.jsonl");
const dataDirectory = join(temporaryRoot, "app-data");
const spacesDirectory = join(temporaryRoot, "spaces");
const providerHome = join(temporaryRoot, "provider-home");
const configuredProviderCliRoot = process.env.CCSM_PROVIDER_CLI_ROOT;
const localProviderCliParent = join(repositoryRoot, "test-results");
mkdirSync(localProviderCliParent, { recursive: true });
const providerCliRoot = configuredProviderCliRoot
  ? resolve(configuredProviderCliRoot)
  : mkdtempSync(
      join(localProviderCliParent, `.provider-clis-e2e-${platform}-`),
    );
const ownsProviderCliRoot = !configuredProviderCliRoot;

mkdirSync(join(artifactDirectory, "logs"), { recursive: true });
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(spacesDirectory, { recursive: true });
mkdirSync(providerHome, { recursive: true });
for (const provider of ["claude", "codex", "copilot", "markdown"]) {
  mkdirSync(join(spacesDirectory, provider), { recursive: true });
}
const baselineSourceProcessIds = new Set(
  listSourceBinaryProcesses().map((entry) => entry.ProcessId),
);
writeFileSync(
  modelStubConfigFile,
  `${JSON.stringify({ providers: {} }, null, 2)}\n`,
);

if (process.argv.includes("--debug")) {
  wdioArguments.push("--logLevel", "debug");
}

const cleanEnvironment = hostRuntimeEnvironment();
let exitCode = 1;
let runnerError;
let modelStub;
const ownedProcessIds = new Set();
if (!existsSync(sourceAppBinary)) {
  runnerError = `E2E executable does not exist at ${sourceAppBinary}; run pnpm test:desktop:build first`;
  console.error(runnerError);
} else {
  try {
    let providerEnvironment = {};
    if (usesProviderHarness) {
      const providerCliEnvironment = ensurePinnedProviderClis();
      modelStub = await startModelStub();
      const modelBaseUrl = `http://127.0.0.1:${modelStub.port}`;
      providerEnvironment = prepareProviderEnvironment(
        providerCliEnvironment,
        modelBaseUrl,
      );
    }
    const environment = {
      ...cleanEnvironment,
      ...providerEnvironment,
      CCSM_DATA_DIR: dataDirectory,
      CCSM_E2E_APP_BINARY: appBinary,
      CCSM_E2E_ARTIFACT_DIR: artifactDirectory,
      CCSM_E2E_MODEL_STUB_FILE: modelStubConfigFile,
      CCSM_E2E_MODEL_STUB_LOG: modelStubLog,
      CCSM_E2E_PLATFORM: platform,
      CCSM_E2E_REAL_PROVIDERS: usesProviderHarness ? "1" : "0",
      CCSM_E2E_RUN_ID: runId,
      CCSM_E2E_RUN_MODE: runMode,
      CCSM_E2E_SCENARIO: selectedScenario,
      CCSM_E2E_TARGET_ROOT_BASE: spacesDirectory,
      CCSM_HOOK_REPORTER_STRICT: "1",
      CI: "1",
      GIT_CEILING_DIRECTORIES: runtimeRootParent,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      HOME: providerHome,
      USERPROFILE: providerHome,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      ...(process.platform === "win32"
        ? {
            LOCALAPPDATA: dataDirectory,
            APPDATA: join(providerHome, "AppData", "Roaming"),
          }
        : {
            XDG_CACHE_HOME: join(dataDirectory, "cache"),
            XDG_CONFIG_HOME: join(dataDirectory, "config"),
            XDG_DATA_HOME: join(dataDirectory, "data"),
          }),
      ...(process.argv.includes("--debug") ? { CCSM_E2E_DEBUG: "1" } : {}),
    };
    const wdioCli = join(
      desktopRoot,
      "node_modules",
      "@wdio",
      "cli",
      "bin",
      "wdio.js",
    );
    const result = spawnSync(
      process.execPath,
      [wdioCli, "run", "wdio.conf.ts", ...wdioArguments],
      {
        cwd: desktopRoot,
        env: environment,
        stdio: "inherit",
      },
    );
    exitCode = result.status ?? 1;
    runnerError = result.error?.message;
    if (runnerError) console.error(runnerError);
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
    console.error(runnerError);
  } finally {
    if (modelStub) {
      try {
        await stopModelStub(modelStub.child);
      } catch (error) {
        runnerError ??= error instanceof Error ? error.message : String(error);
        exitCode = 1;
      }
    }
  }
}

copyFileSync(
  modelStubConfigFile,
  join(artifactDirectory, "logs", "model-stub-config.json"),
);
splitServiceLogs();
const logDiagnostics = auditServiceLogs();
if (logDiagnostics.unexpectedErrors.length > 0) {
  runnerError ??= `desktop logs contain ${logDiagnostics.unexpectedErrors.length} unexpected error line(s)`;
  exitCode = 1;
}
const observedBeforeTermination = waitForProcessCleanup(temporaryRoot, 5_000);
if (observedBeforeTermination.length > 0) {
  terminateOwnedProcesses(observedBeforeTermination);
}
const lingeringProcesses = waitForProcessCleanup(temporaryRoot, 5_000);
writeFileSync(
  join(artifactDirectory, "process-cleanup.json"),
  `${JSON.stringify(
    {
      sourceAppBinary,
      appBinary,
      binaryMode: "job-build-with-pid-baseline",
      ownershipRoots: [temporaryRoot, providerCliRoot],
      ownedProcessIds: [...ownedProcessIds],
      checkedAt: new Date().toISOString(),
      clean: lingeringProcesses.length === 0,
      gracefulCleanup: observedBeforeTermination.length === 0,
      observedBeforeTermination,
      lingeringProcesses,
    },
    null,
    2,
  )}\n`,
);
if (observedBeforeTermination.length > 0) {
  console.error(
    "Desktop E2E left owned processes running:",
    observedBeforeTermination,
  );
  exitCode = 1;
}
if (lingeringProcesses.length > 0) {
  console.error(
    "Desktop E2E could not terminate owned processes:",
    lingeringProcesses,
  );
  exitCode = 1;
}

const resultPath = join(artifactDirectory, "result.json");
const credentialFindings = sanitizeTextArtifacts();
writeFileSync(
  join(artifactDirectory, "credential-scan.json"),
  `${JSON.stringify(
    {
      clean: credentialFindings.length === 0,
      findings: credentialFindings,
    },
    null,
    2,
  )}\n`,
);
if (credentialFindings.length > 0) {
  runnerError ??= `artifact credential scan matched ${credentialFindings.length} file(s)`;
  exitCode = 1;
}

if (lingeringProcesses.length === 0) {
  try {
    removeTemporaryRoot();
    if (ownsProviderCliRoot) removeOwnedProviderCliRoot();
  } catch (error) {
    runnerError ??= `remove E2E runtime: ${error instanceof Error ? error.message : String(error)}`;
    exitCode = 1;
  }
}
ensureResultReflectsRunnerStatus();
sanitizeTextArtifacts();
writeManifest();
appendGitHubSummary();
process.exitCode = exitCode;

function ensurePinnedProviderClis() {
  const environmentPath = join(
    providerCliRoot,
    "provider-cli-environment.json",
  );
  const expectedLockSha256 = createHash("sha256")
    .update(
      readFileSync(
        join(desktopRoot, "e2e", "provider-cli-contract", "package-lock.json"),
      ),
    )
    .digest("hex");
  if (!existsSync(environmentPath)) {
    const result = spawnSync(
      process.execPath,
      [join(scriptDirectory, "run-provider-cli-contract.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...cleanEnvironment,
          CCSM_E2E_APP_BINARY: appBinary,
          CCSM_E2E_ARTIFACT_DIR: artifactDirectory,
          CCSM_PROVIDER_CLI_ROOT: providerCliRoot,
        },
        stdio: "inherit",
      },
    );
    if (result.status !== 0 || result.error) {
      throw new Error(
        result.error?.message ??
          `pinned provider CLI setup exited with code ${result.status}`,
      );
    }
  }
  const value = JSON.parse(readFileSync(environmentPath, "utf8"));
  if (value.platform !== platform || value.architecture !== process.arch) {
    throw new Error(
      `provider CLI environment targets ${value.platform}-${value.architecture}; expected ${platform}-${process.arch}`,
    );
  }
  if (value.lockSha256 !== expectedLockSha256) {
    throw new Error(
      "provider CLI environment does not match the committed package-lock.json; run pnpm test:provider-cli-contract",
    );
  }
  for (const provider of ["claude", "codex", "copilot"]) {
    if (
      !value.providers?.[provider] ||
      !existsSync(value.providers[provider])
    ) {
      throw new Error(`pinned ${provider} executable is missing`);
    }
  }
  return value.providers;
}

function prepareProviderEnvironment(providers, modelBaseUrl) {
  const claudeHome = join(providerHome, ".claude");
  const codexHome = join(providerHome, ".codex");
  const copilotHome = join(providerHome, ".copilot");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  mkdirSync(join(providerHome, "AppData", "Roaming"), { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    `${JSON.stringify({}, null, 2)}\n`,
  );
  writeFileSync(
    join(providerHome, ".claude.json"),
    `${JSON.stringify(
      {
        hasCompletedOnboarding: true,
        theme: "dark",
        autoUpdates: false,
        projects: Object.fromEntries(
          ["claude", "codex", "copilot"].map((provider) => [
            canonicalPath(join(spacesDirectory, provider)),
            {
              allowedTools: [],
              hasTrustDialogAccepted: true,
              hasCompletedProjectOnboarding: true,
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model = "gpt-5.6-sol"',
      'model_provider = "ccsm_local"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
      "[model_providers.ccsm_local]",
      'name = "CCSM local model stub"',
      `base_url = "${modelBaseUrl}/codex/v1"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  return {
    CCSM_REAL_CLAUDE_PATH: providers.claude,
    CCSM_REAL_CODEX_PATH: providers.codex,
    CCSM_REAL_COPILOT_PATH: providers.copilot,
    CCSM_CLAUDE_BASE_URL: `${modelBaseUrl}/claude`,
    CCSM_CLAUDE_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_API_KEY: "ccsm-e2e-model-stub-key",
    ANTHROPIC_BASE_URL: `${modelBaseUrl}/claude`,
    CLAUDE_CODE_API_BASE_URL: `${modelBaseUrl}/claude`,
    CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    OPENAI_API_KEY: "ccsm-e2e-model-stub-key",
    CODEX_HOME: codexHome,
    COPILOT_HOME: copilotHome,
    COPILOT_OFFLINE: "true",
    COPILOT_ENABLE_ALT_PROVIDERS: "true",
    COPILOT_PROVIDER_BASE_URL: `${modelBaseUrl}/copilot/v1`,
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_API_KEY: "ccsm-e2e-model-stub-key",
    COPILOT_PROVIDER_WIRE_API: "responses",
    COPILOT_PROVIDER_TRANSPORT: "http",
    COPILOT_PROVIDER_MODEL_ID: "gpt-5.6-sol",
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    COPILOT_MODEL: "gpt-5.6-sol",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_DEBUG_SKIP_LAUNCH_CHECKS: "1",
    COPILOT_DISABLE_DESKTOP_NOTIFICATIONS: "1",
    COPILOT_DISABLE_TERMINAL_TITLE: "1",
    COPILOT_SETUP_TERMINAL: "0",
  };
}

function startModelStub() {
  writeFileSync(modelStubLog, "");
  const child = spawn(
    process.execPath,
    [join(scriptDirectory, "provider-model-stub.mjs")],
    {
      cwd: repositoryRoot,
      env: {
        ...cleanEnvironment,
        CCSM_PROVIDER_MODEL_STUB_CONFIG: modelStubConfigFile,
        CCSM_PROVIDER_MODEL_STUB_KEY: "ccsm-e2e-model-stub-key",
        CCSM_PROVIDER_MODEL_STUB_LOG: modelStubLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.pid) ownedProcessIds.add(child.pid);
  return new Promise((resolveStub, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`provider model stub did not become ready: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/CCSM_PROVIDER_MODEL_STUB_READY (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveStub({ child, port: Number(match[1]) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes("CCSM_PROVIDER_MODEL_STUB_READY")) {
        reject(new Error(`provider model stub exited with ${code}: ${stderr}`));
      }
    });
  });
}

function stopModelStub(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return stopChild(child, "SIGTERM", 5_000).then(async (stopped) => {
    if (stopped) return;
    child.kill("SIGKILL");
    if (!(await waitForChildExit(child, 5_000))) {
      throw new Error("provider model stub survived SIGKILL for five seconds");
    }
    throw new Error("provider model stub required forced termination");
  });
}

function stopChild(child, signal, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  child.kill(signal);
  return waitForChildExit(child, timeoutMs);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function waitForProcessCleanup(ownershipRoot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let processes = listProcesses(ownershipRoot);
  while (processes.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    processes = listProcesses(ownershipRoot);
  }
  return processes;
}

function ensureResultReflectsRunnerStatus() {
  let results = [];
  if (existsSync(resultPath)) {
    try {
      results = JSON.parse(readFileSync(resultPath, "utf8"));
      if (!Array.isArray(results)) throw new Error("expected an array");
    } catch (error) {
      runnerError ??= `read result.json: ${error.message}`;
      exitCode = 1;
      results = [];
    }
  }
  if (results.length === 0) {
    runnerError ??= "WDIO produced no scenario results";
    exitCode = 1;
  }
  const scenarioContract = plannedScenarioIds;
  const observedScenarioIds = results
    .filter((row) => row.scenarioId !== "runner")
    .map((row) => row.scenarioId);
  const missingScenarioIds = scenarioContract.filter(
    (scenarioId) => !observedScenarioIds.includes(scenarioId),
  );
  const unexpectedScenarioIds = observedScenarioIds.filter(
    (scenarioId) => !scenarioContract.includes(scenarioId),
  );
  const duplicateScenarioIds = observedScenarioIds.filter(
    (scenarioId, index) => observedScenarioIds.indexOf(scenarioId) !== index,
  );
  if (
    missingScenarioIds.length > 0 ||
    unexpectedScenarioIds.length > 0 ||
    duplicateScenarioIds.length > 0
  ) {
    const contractError = `scenario result contract mismatch: expected=${scenarioContract.join(",")} observed=${observedScenarioIds.join(",")}`;
    runnerError ??= contractError;
    exitCode = 1;
    results.push({
      scenarioId: "runner",
      title: "Desktop E2E scenario contract",
      fullTitle: "Desktop E2E expected scenario set",
      state: "failed",
      durationMs: 0,
      failureStep: "scenario-contract",
      error: contractError,
    });
  }
  if (results.some((row) => row.state !== "passed")) exitCode = 1;
  if (
    results.length === 0 ||
    (exitCode !== 0 &&
      results.every((row) => row.state === "passed") &&
      !results.some((row) => row.scenarioId === "runner"))
  ) {
    const cleanupError =
      observedBeforeTermination.length > 0
        ? `owned process cleanup required forced termination (${observedBeforeTermination.length} process(es))`
        : lingeringProcesses.length > 0
          ? `owned process cleanup left ${lingeringProcesses.length} process(es)`
          : undefined;
    results.push({
      scenarioId: "runner",
      title: "Desktop E2E runner",
      fullTitle: "Desktop E2E runner and cleanup",
      state: "failed",
      durationMs: 0,
      failureStep: cleanupError ? "process-cleanup" : "runner",
      error: runnerError ?? cleanupError ?? `WDIO exited with code ${exitCode}`,
    });
  }
  writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`);
}

function expectedScenarioIds(selected, cliArguments) {
  const scenarios = {
    all: [
      "claude-resume",
      "codex-resume",
      "ghcp-resume",
      "markdown-edit-preview",
    ],
    claude: ["claude-resume"],
    codex: ["codex-resume"],
    ghcp: ["ghcp-resume"],
    markdown: ["markdown-edit-preview"],
  };
  const selectedScenarioIds = scenarios[selected] ?? scenarios.all;
  const requestedSpecs = [];
  for (let index = 0; index < cliArguments.length; index += 1) {
    const argument = cliArguments[index];
    if (argument === "--spec" && cliArguments[index + 1]) {
      requestedSpecs.push(cliArguments[index + 1]);
      index += 1;
    } else if (argument.startsWith("--spec=")) {
      requestedSpecs.push(argument.slice("--spec=".length));
    }
  }
  if (requestedSpecs.length === 0) return selectedScenarioIds;

  const specScenarioIds = new Set();
  for (const spec of requestedSpecs) {
    const normalized = spec.replaceAll("\\", "/").toLowerCase();
    if (normalized.includes("markdown-editor.spec")) {
      specScenarioIds.add("markdown-edit-preview");
    }
    if (normalized.includes("provider-resume.spec")) {
      specScenarioIds.add("claude-resume");
      specScenarioIds.add("codex-resume");
      specScenarioIds.add("ghcp-resume");
    }
  }
  if (specScenarioIds.size === 0) return selectedScenarioIds;
  return selectedScenarioIds.filter((scenarioId) =>
    specScenarioIds.has(scenarioId),
  );
}

function listProcesses(ownershipRoot) {
  try {
    if (process.platform === "win32") {
      const script = [
        "$root = [IO.Path]::GetFullPath($env:CCSM_E2E_OWNERSHIP_ROOT).TrimEnd('\\') + '\\'",
        "$provider = [IO.Path]::GetFullPath($env:CCSM_E2E_PROVIDER_ROOT).TrimEnd('\\') + '\\'",
        "$source = [IO.Path]::GetFullPath($env:CCSM_E2E_SOURCE_BINARY)",
        "$owned = @($env:CCSM_E2E_OWNED_PROCESS_IDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })",
        "$items = @(Get-CimInstance Win32_Process | Where-Object { $owned -contains [int]$_.ProcessId -or ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($provider, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFullPath($_.ExecutablePath) -eq $source)) -or ($_.CommandLine -and ($_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($provider, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
        "$items | ConvertTo-Json -Compress",
      ].join("; ");
      const output = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CCSM_E2E_OWNERSHIP_ROOT: ownershipRoot,
            CCSM_E2E_PROVIDER_ROOT: providerCliRoot,
            CCSM_E2E_SOURCE_BINARY: sourceAppBinary,
            CCSM_E2E_OWNED_PROCESS_IDS: [...ownedProcessIds].join(","),
          },
        },
      ).trim();
      if (!output) return [];
      const parsed = JSON.parse(output);
      const processes = Array.isArray(parsed) ? parsed : [parsed];
      return processes.filter(
        (entry) => !baselineSourceProcessIds.has(Number(entry.ProcessId)),
      );
    }
    return listUnixProcesses().filter(
      (entry) =>
        !baselineSourceProcessIds.has(entry.ProcessId) &&
        (ownedProcessIds.has(entry.ProcessId) ||
          entry.CommandLine.includes(ownershipRoot) ||
          entry.CommandLine.includes(providerCliRoot) ||
          entry.CommandLine.includes(sourceAppBinary)),
    );
  } catch (error) {
    return [{ inspectionError: error.message }];
  }
}

function listSourceBinaryProcesses() {
  if (process.platform !== "win32") {
    return listUnixProcesses().filter((entry) =>
      entry.CommandLine.includes(sourceAppBinary),
    );
  }
  try {
    const script = [
      "$source = [IO.Path]::GetFullPath($env:CCSM_E2E_SOURCE_BINARY)",
      "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $source } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
      "$items | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CCSM_E2E_SOURCE_BINARY: sourceAppBinary },
      },
    ).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function listUnixProcesses() {
  try {
    return execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((match) => ({
        ProcessId: Number(match[1]),
        ParentProcessId: Number(match[2]),
        CommandLine: match[3],
      }));
  } catch {
    return [];
  }
}

function terminateOwnedProcesses(processes) {
  const processIds = processes
    .map((entry) => Number(entry.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  if (processIds.length === 0) return;
  if (process.platform === "win32") {
    const script = [
      "$ids = $env:CCSM_E2E_PROCESS_IDS -split ',' | ForEach-Object { [int]$_ }",
      "foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
    ].join("; ");
    try {
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: {
            ...process.env,
            CCSM_E2E_PROCESS_IDS: processIds.join(","),
          },
          stdio: "ignore",
        },
      );
    } catch {}
    return;
  }
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function writeManifest() {
  const packageJson = JSON.parse(
    readFileSync(join(desktopRoot, "package.json"), "utf8"),
  );
  const files = walkFiles(artifactDirectory)
    .filter((path) => basename(path) !== "manifest.json")
    .map((path) => ({
      path: relative(artifactDirectory, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
  let commitSha = process.env.GITHUB_SHA;
  if (!commitSha) {
    try {
      commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      commitSha = "unknown";
    }
  }
  const results = JSON.parse(readFileSync(resultPath, "utf8"));
  const webviewVersion = detectWebviewVersion();
  writeFileSync(
    join(artifactDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        runId,
        runMode,
        commitSha,
        platform,
        architecture: process.arch,
        appVersion: packageJson.version,
        webviewVersion,
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
        finalStatus:
          exitCode === 0 && results.every((result) => result.state === "passed")
            ? "passed"
            : "failed",
        cleanupStatus: {
          clean: lingeringProcesses.length === 0,
          graceful: observedBeforeTermination.length === 0,
        },
        scenarios: results.map((result) => ({
          scenarioId: result.scenarioId,
          fullTitle: result.fullTitle,
          state: result.state,
          durationMs: result.durationMs,
          ...(result.failureStep ? { failureStep: result.failureStep } : {}),
        })),
        generatedAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    )}\n`,
  );
}

function splitServiceLogs() {
  const logDirectory = join(artifactDirectory, "logs");
  const serviceLogs = readdirSync(logDirectory)
    .filter((name) => /^wdio-.*\.log$/.test(name))
    .sort()
    .flatMap((name) =>
      readFileSync(join(logDirectory, name), "utf8")
        .replaceAll("\0", "")
        .split("\n"),
    );
  writeFileSync(join(logDirectory, "wdio.log"), `${serviceLogs.join("\n")}\n`);
  const backend = serviceLogs.filter((line) =>
    line.includes("[Tauri:Backend:"),
  );
  const frontend = serviceLogs.filter(
    (line) => line.includes("[Tauri:Frontend:") || line.includes("[frontend]"),
  );
  writeFileSync(join(logDirectory, "backend.log"), `${backend.join("\n")}\n`);
  writeFileSync(join(logDirectory, "frontend.log"), `${frontend.join("\n")}\n`);
}

function auditServiceLogs() {
  const logDirectory = join(artifactDirectory, "logs");
  const files = ["frontend.log", "backend.log", "wdio.log"];
  const lines = [
    ...new Set(
      files.flatMap((name) =>
        readFileSync(join(logDirectory, name), "utf8").split("\n"),
      ),
    ),
  ];
  const knownWindowsJsonWarning =
    /JSON error: invalid type: null, expected u32 at line 1 column \d+/u;
  const knownLinuxHeadlessWarnings = [
    /AT-SPI: Error retrieving accessibility bus address: org\.freedesktop\.DBus\.Error\.ServiceUnknown/u,
    /libEGL warning: DRI3 error: Could not get DRI3 device/u,
  ];
  const candidateErrors = lines.filter(
    (line) =>
      /\b(?:ERROR|fatal|panic)\b/iu.test(line) || line.includes("JSON error:"),
  );
  const knownWindowsWarnings = candidateErrors.filter(
    (line) => platform === "windows" && knownWindowsJsonWarning.test(line),
  );
  const knownLinuxWarnings = candidateErrors.filter(
    (line) =>
      platform === "linux" &&
      knownLinuxHeadlessWarnings.some((pattern) => pattern.test(line)),
  );
  const unexpectedErrors = candidateErrors.filter(
    (line) =>
      !(platform === "windows" && knownWindowsJsonWarning.test(line)) &&
      !(
        platform === "linux" &&
        knownLinuxHeadlessWarnings.some((pattern) => pattern.test(line))
      ),
  );
  const value = {
    clean: unexpectedErrors.length === 0,
    knownWarnings: {
      windowsWdioNullableU32: knownWindowsWarnings.length,
      linuxHeadlessDesktop: knownLinuxWarnings.length,
      explanations: {
        windowsWdioNullableU32:
          "tauri-plugin-wdio-webdriver 1.3.0 emits this Windows input-probe serialization warning while the corresponding WebDriver action succeeds",
        linuxHeadlessDesktop:
          "Ubuntu Xvfb runners emit AT-SPI bus and DRI3 device warnings while WebKitGTK renders through the configured virtual display",
      },
    },
    unexpectedErrors: [...new Set(unexpectedErrors)].slice(0, 50),
  };
  writeFileSync(
    join(artifactDirectory, "log-diagnostics.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  return value;
}

function sanitizeTextArtifacts() {
  const findings = [];
  const credentialPatterns = [
    [
      "github-token",
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    ],
    ["hook-token", /(CCSM_HOOK_TOKEN[\s=:"']+)[^\s,"']+/gi],
    ["bearer-token", /(Authorization[\s=:"']+Bearer\s+)[^\s,"']+/gi],
  ];
  const replacements = [
    [temporaryRoot, "<CCSM_E2E_TEMP>"],
    [canonicalPath(temporaryRoot), "<CCSM_E2E_TEMP>"],
    [repositoryRoot, "<REPOSITORY_ROOT>"],
    [canonicalPath(repositoryRoot), "<REPOSITORY_ROOT>"],
    [sourceAppBinary, "<SOURCE_APP_BINARY>"],
    [canonicalPath(sourceAppBinary), "<SOURCE_APP_BINARY>"],
    [providerCliRoot, "<PROVIDER_CLI_ROOT>"],
    [canonicalPath(providerCliRoot), "<PROVIDER_CLI_ROOT>"],
  ].sort((left, right) => right[0].length - left[0].length);
  for (const path of walkFiles(artifactDirectory)) {
    if (!/\.(?:json|jsonl|log|txt|xml)$/i.test(path)) continue;
    let contents = readFileSync(path, "utf8").replaceAll("\0", "");
    for (const [kind, pattern] of credentialPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(contents)) {
        findings.push({
          path: relative(artifactDirectory, path).replaceAll("\\", "/"),
          kind,
        });
      }
    }
    for (const [value, replacement] of replacements) {
      const variants = new Set([
        value,
        value.replaceAll("\\", "/"),
        value.replaceAll("\\", "\\\\"),
      ]);
      for (const variant of variants) {
        contents = contents.replaceAll(variant, replacement);
      }
    }
    contents = contents
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        "<REDACTED_GITHUB_TOKEN>",
      )
      .replace(/(CCSM_HOOK_TOKEN[\s=:"']+)[^\s,"']+/gi, "$1<REDACTED>")
      .replace(/(Authorization[\s=:"']+Bearer\s+)[^\s,"']+/gi, "$1<REDACTED>");
    writeFileSync(path, contents);
  }
  return findings;
}

function hostRuntimeEnvironment() {
  const allowed = new Set(
    [
      "ALLUSERSPROFILE",
      "COLORTERM",
      "COMMONPROGRAMFILES",
      "COMMONPROGRAMFILES(X86)",
      "COMSPEC",
      "DBUS_SESSION_BUS_ADDRESS",
      "DISPLAY",
      "DYLD_LIBRARY_PATH",
      "GDK_BACKEND",
      "LANG",
      "LANGUAGE",
      "LC_ALL",
      "LC_CTYPE",
      "LD_LIBRARY_PATH",
      "LIBGL_ALWAYS_SOFTWARE",
      "LOGNAME",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "PATH",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_IDENTIFIER",
      "PROGRAMDATA",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "SHELL",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "TZ",
      "USER",
      "WAYLAND_DISPLAY",
      "WEBKIT_DISABLE_COMPOSITING_MODE",
      "WEBKIT_DISABLE_DMABUF_RENDERER",
      "WINDIR",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
    ].map((name) => name.toUpperCase()),
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      allowed.has(name.toUpperCase()),
    ),
  );
}

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function detectWebviewVersion() {
  const capabilitiesPath = join(artifactDirectory, "capabilities.json");
  if (existsSync(capabilitiesPath)) {
    const capabilities = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
    if (capabilities.browserName || capabilities.browserVersion) {
      return `${capabilities.browserName ?? "webview"} ${capabilities.browserVersion ?? "unknown"}`;
    }
  }
  const logDirectory = join(artifactDirectory, "logs");
  const contents = readdirSync(logDirectory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(logDirectory, name), "utf8"))
    .join("\n");
  const edge = contents.match(/msedge \(v([^\)]+)\)/i);
  if (edge) return `msedge ${edge[1]}`;
  const webkit = contents.match(/WebKitGTK[^\d]*(\d+(?:\.\d+){1,3})/i);
  if (webkit) return `WebKitGTK ${webkit[1]}`;
  return "unknown";
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function appendGitHubSummary() {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const results = JSON.parse(readFileSync(resultPath, "utf8"));
  const lines = [
    `## Desktop E2E — ${platform}`,
    "",
    `Final gate: **${exitCode === 0 && results.every((result) => result.state === "passed") ? "passed" : "failed"}**`,
    "",
    `Artifact directory: \`${artifactDirectory}\``,
    "",
    "| Scenario | Result | Duration |",
    "| --- | --- | ---: |",
    ...results.map(
      (result) =>
        `| ${result.fullTitle} | ${result.state} | ${result.durationMs} ms |`,
    ),
    "",
  ];
  writeFileSync(summary, `${lines.join("\n")}\n`, { flag: "a" });
}

function removeTemporaryRoot() {
  const resolvedParent = realpathSync(runtimeRootParent);
  const resolvedRoot = realpathSync(temporaryRoot);
  const expectedPrefix = `${resolvedParent}${sep}`;
  if (
    !resolvedRoot.startsWith(expectedPrefix) ||
    !basename(resolvedRoot).startsWith(`.ccsm-e2e-${platform}-`)
  ) {
    throw new Error(
      `refusing to remove unexpected E2E temp path ${resolvedRoot}`,
    );
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function removeOwnedProviderCliRoot() {
  const resolvedParent = realpathSync(localProviderCliParent);
  const resolvedRoot = realpathSync(providerCliRoot);
  const expectedPrefix = `${resolvedParent}${sep}`;
  if (
    !resolvedRoot.startsWith(expectedPrefix) ||
    !basename(resolvedRoot).startsWith(`.provider-clis-e2e-${platform}-`)
  ) {
    throw new Error(
      `refusing to remove unexpected provider CLI path ${resolvedRoot}`,
    );
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}
