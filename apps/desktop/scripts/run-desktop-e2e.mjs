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
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
const artifactDirectory = resolve(
  process.env.CCSM_E2E_ARTIFACT_DIR ??
    join(repositoryRoot, "test-results", "desktop", platform, runId),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), `ccsm-e2e-${platform}-`));
const binaryName =
  process.platform === "win32" ? "ccsm-desktop.exe" : "ccsm-desktop";
const sourceAppBinary = resolve(
  process.env.CCSM_E2E_APP_BINARY ??
    join(repositoryRoot, "target", "debug", binaryName),
);
const appBinary = sourceAppBinary;
const modelMockFile = join(temporaryRoot, "model-mock.json");
const modelMockLog = join(artifactDirectory, "logs", "model-mock.jsonl");
const dataDirectory = join(temporaryRoot, "app-data");
const spacesDirectory = join(temporaryRoot, "spaces");

mkdirSync(join(artifactDirectory, "logs"), { recursive: true });
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(spacesDirectory, { recursive: true });
for (const provider of ["claude", "codex", "copilot"]) {
  mkdirSync(join(spacesDirectory, provider), { recursive: true });
}
const baselineSourceProcessIds = new Set(
  listSourceBinaryProcesses().map((entry) => entry.ProcessId),
);
writeFileSync(
  modelMockFile,
  `${JSON.stringify({ defaultResponse: "CCSM_E2E_DEFAULT_RESPONSE", providers: {} }, null, 2)}\n`,
);

const ownArguments = new Set(["--ci", "--debug", "--evidence"]);
const wdioArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--" && !ownArguments.has(argument));
if (process.argv.includes("--debug")) {
  wdioArguments.push("--logLevel", "debug");
}

const inheritedRuntimeVariables = new Set([
  "CCSM_HOOK_PIPE",
  "CCSM_HOOK_REPORTER",
  "CCSM_HOOK_REPORTER_STRICT",
  "CCSM_HOOK_TOKEN",
  "CCSM_DATA_DIR",
  "CCSM_NATIVE_SESSION_ID",
  "CCSM_PROVIDER",
  "CCSM_RUNTIME_ID",
  "CCSM_SESSION_ID",
  "CCSM_WRAPPER_ACTIVE",
]);
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !inheritedRuntimeVariables.has(name),
  ),
);
const environment = {
  ...cleanEnvironment,
  CCSM_DATA_DIR: dataDirectory,
  CCSM_E2E_APP_BINARY: appBinary,
  CCSM_E2E_ARTIFACT_DIR: artifactDirectory,
  CCSM_E2E_MODEL_MOCK: "1",
  CCSM_E2E_MODEL_MOCK_FILE: modelMockFile,
  CCSM_E2E_MODEL_MOCK_LOG: modelMockLog,
  CCSM_E2E_PLATFORM: platform,
  CCSM_E2E_RUN_ID: runId,
  CCSM_E2E_RUN_MODE: runMode,
  CCSM_E2E_TARGET_ROOT_BASE: spacesDirectory,
  CCSM_HOOK_REPORTER_STRICT: "1",
  CCSM_REAL_CLAUDE_PATH: appBinary,
  CCSM_REAL_CODEX_PATH: appBinary,
  CCSM_REAL_COPILOT_PATH: appBinary,
  ...(process.platform === "win32"
    ? { LOCALAPPDATA: dataDirectory }
    : {
        XDG_CACHE_HOME: join(dataDirectory, "cache"),
        XDG_CONFIG_HOME: join(dataDirectory, "config"),
        XDG_DATA_HOME: join(dataDirectory, "data"),
      }),
  ...(process.argv.includes("--debug") ? { CCSM_E2E_DEBUG: "1" } : {}),
};

let exitCode = 1;
let runnerError;
if (!existsSync(sourceAppBinary)) {
  runnerError = `E2E executable does not exist at ${sourceAppBinary}; run pnpm test:desktop:build first`;
  console.error(runnerError);
} else {
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
}

copyFileSync(
  modelMockFile,
  join(artifactDirectory, "logs", "model-mock-config.json"),
);
splitServiceLogs();
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
      ownershipRoot: temporaryRoot,
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

ensureResultReflectsRunnerStatus();
sanitizeTextArtifacts();
writeManifest();
appendGitHubSummary();
if (lingeringProcesses.length === 0) removeTemporaryRoot();
process.exitCode = exitCode;

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
  if (results.some((row) => row.state !== "passed")) exitCode = 1;
  if (
    results.length === 0 ||
    (exitCode !== 0 && results.every((row) => row.state === "passed"))
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

function listProcesses(ownershipRoot) {
  try {
    if (process.platform === "win32") {
      const script = [
        "$root = [IO.Path]::GetFullPath($env:CCSM_E2E_OWNERSHIP_ROOT).TrimEnd('\\') + '\\'",
        "$source = [IO.Path]::GetFullPath($env:CCSM_E2E_SOURCE_BINARY)",
        "$items = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFullPath($_.ExecutablePath) -eq $source)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
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
            CCSM_E2E_SOURCE_BINARY: sourceAppBinary,
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
        (entry.CommandLine.includes(ownershipRoot) ||
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
    [repositoryRoot, "<REPOSITORY_ROOT>"],
    [sourceAppBinary, "<SOURCE_APP_BINARY>"],
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
  const resolvedTemp = realpathSync(tmpdir());
  const resolvedRoot = realpathSync(temporaryRoot);
  const expectedPrefix = `${resolvedTemp}${sep}`;
  if (
    !resolvedRoot.startsWith(expectedPrefix) ||
    !basename(resolvedRoot).startsWith(`ccsm-e2e-${platform}-`)
  ) {
    throw new Error(
      `refusing to remove unexpected E2E temp path ${resolvedRoot}`,
    );
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}
