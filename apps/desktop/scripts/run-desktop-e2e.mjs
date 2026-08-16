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
const artifactDirectory = resolve(
  process.env.CCSM_E2E_ARTIFACT_DIR ??
    join(repositoryRoot, "test-results", "desktop", platform, runId),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), `ccsm-e2e-${platform}-`));
const binaryName =
  process.platform === "win32" ? "ccsm-desktop.exe" : "ccsm-desktop";
const appBinary = resolve(
  process.env.CCSM_E2E_APP_BINARY ??
    join(repositoryRoot, "target", "debug", binaryName),
);
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
  CCSM_E2E_TARGET_ROOT_BASE: spacesDirectory,
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
if (!existsSync(appBinary)) {
  runnerError = `E2E executable does not exist at ${appBinary}; run pnpm test:desktop:build first`;
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
const lingeringProcesses = waitForProcessCleanup(appBinary, 5_000);
writeFileSync(
  join(artifactDirectory, "process-cleanup.json"),
  `${JSON.stringify(
    {
      appBinary,
      checkedAt: new Date().toISOString(),
      clean: lingeringProcesses.length === 0,
      lingeringProcesses,
    },
    null,
    2,
  )}\n`,
);
if (lingeringProcesses.length > 0) {
  console.error(
    "Desktop E2E left owned processes running:",
    lingeringProcesses,
  );
  exitCode = 1;
}

const resultPath = join(artifactDirectory, "result.json");
if (!existsSync(resultPath)) {
  writeFileSync(
    resultPath,
    `${JSON.stringify(
      [
        {
          title: "Desktop E2E runner",
          fullTitle: "Desktop E2E runner",
          state: "failed",
          durationMs: 0,
          error: runnerError ?? `WDIO exited with code ${exitCode}`,
        },
      ],
      null,
      2,
    )}\n`,
  );
}

writeManifest();
appendGitHubSummary();
removeTemporaryRoot();
process.exitCode = exitCode;

function waitForProcessCleanup(targetBinary, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let processes = listProcesses(targetBinary);
  while (processes.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    processes = listProcesses(targetBinary);
  }
  return processes;
}

function listProcesses(targetBinary) {
  try {
    if (process.platform === "win32") {
      const script = [
        "$target = [IO.Path]::GetFullPath($env:CCSM_E2E_SCAN_BINARY)",
        "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
        "$items | ConvertTo-Json -Compress",
      ].join("; ");
      const output = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CCSM_E2E_SCAN_BINARY: targetBinary },
        },
      ).trim();
      if (!output) return [];
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((line) => line.includes(targetBinary))
      .map((line) => ({ command: line.trim() }));
  } catch (error) {
    return [{ inspectionError: error.message }];
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
        commitSha,
        platform,
        architecture: process.arch,
        appVersion: packageJson.version,
        webviewVersion,
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
        scenarios: results.map((result) => ({
          fullTitle: result.fullTitle,
          state: result.state,
          durationMs: result.durationMs,
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
    .flatMap((name) =>
      readFileSync(join(logDirectory, name), "utf8").split("\n"),
    );
  const backend = serviceLogs.filter((line) =>
    line.includes("[Tauri:Backend:"),
  );
  const frontend = serviceLogs.filter(
    (line) => line.includes("[Tauri:Frontend:") || line.includes("[frontend]"),
  );
  writeFileSync(join(logDirectory, "backend.log"), `${backend.join("\n")}\n`);
  writeFileSync(join(logDirectory, "frontend.log"), `${frontend.join("\n")}\n`);
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
