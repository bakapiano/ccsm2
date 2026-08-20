import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { remote } from "webdriverio";

const waitStepMs = 250;

export function createInstalledUpdateManifest({
  version,
  target,
  artifactUrl,
  signature,
}) {
  return {
    version,
    notes: "CCSM installed updater E2E candidate.",
    pub_date: "2026-08-20T00:00:00Z",
    platforms: {
      [target]: { url: artifactUrl, signature },
    },
  };
}

export function assertInstalledUpdateRequestTrace(paths, artifactName) {
  const expected = [
    "/unavailable/latest.json",
    "/primary/latest.json",
    `/primary/${artifactName}`,
    "/fallback/latest.json",
    `/artifacts/${artifactName}`,
  ];
  let cursor = 0;
  for (const path of paths) {
    if (path === expected[cursor]) cursor += 1;
  }
  assert.equal(
    cursor,
    expected.length,
    `updater request trace did not contain ${expected.join(" -> ")}; received ${paths.join(" -> ")}`,
  );
}

export async function runInstalledUpdateE2e(options) {
  const appBinary = requiredFile(options.appBinary, "installed application");
  const updateArtifact = requiredFile(
    options.updateArtifact,
    "update artifact",
  );
  const signature = readFileSync(
    requiredFile(options.updateSignature, "update signature"),
    "utf8",
  ).trim();
  if (!signature) throw new Error("update signature is empty");
  const outputDirectory = resolve(options.outputDirectory);
  const dataDirectory = resolve(options.dataDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  const dataSentinelPath = join(dataDirectory, "installed-update-sentinel.txt");
  const dataSentinel = `${options.variant}:${options.baseVersion}->${options.candidateVersion}`;
  writeFileSync(dataSentinelPath, dataSentinel);

  const artifactName = basename(updateArtifact);
  const requestRecords = [];
  const server = createUpdateServer({
    port: options.endpointPort,
    artifactName,
    artifactPath: updateArtifact,
    signature,
    target: options.target,
    version: options.candidateVersion,
    requestRecords,
  });
  const logPath = join(outputDirectory, `${options.variant}.log`);
  const resultPath = join(outputDirectory, `${options.variant}.json`);
  const windowsHandoffPath = join(
    outputDirectory,
    "windows-updater-handoff.json",
  );
  const logFd = openSync(logPath, "a");
  let initialProcess;
  let installerProcess;
  let verificationProcess;
  let initialBrowser;
  let restartedBrowser;
  let automaticRestart;
  let result;

  try {
    await listen(server, options.endpointPort);
    const environment = installedAppEnvironment(
      dataDirectory,
      options.driverPort,
    );
    if (process.platform === "win32") {
      environment.CCSM_E2E_WINDOWS_UPDATER_HANDOFF_FILE = windowsHandoffPath;
    }
    const appArguments = [];
    initialProcess = spawn(appBinary, appArguments, {
      env: environment,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    const initialPid = initialProcess.pid;
    if (!initialPid)
      throw new Error("installed application did not return a PID");
    await waitForDriver(options.driverPort, true, 120_000, initialProcess);
    initialBrowser = await connectDriver(options.driverPort, appBinary);
    await waitForApplication(initialBrowser);
    assert.ok(existsSync(join(dataDirectory, "data.db")));

    const initialVersion = await openSettings(initialBrowser);
    assert.equal(initialVersion, `Current version ${options.baseVersion}`);
    await initialBrowser.$('[data-theme-choice="dark"]').click();
    await initialBrowser.waitUntil(
      async () =>
        (await initialBrowser.execute(
          () => document.documentElement.dataset.theme,
        )) === "dark",
      { timeout: 10_000, timeoutMsg: "dark theme was not applied" },
    );
    await initialBrowser.pause(2_000);
    await initialBrowser.$('[data-settings-action="check"]').click();
    await initialBrowser.waitUntil(
      async () =>
        (await initialBrowser.$(".settings-update-status").getText()) ===
        `Version ${options.candidateVersion} is available.`,
      { timeout: 30_000, timeoutMsg: "signed update was not discovered" },
    );
    assert.equal(
      await initialBrowser.$(".settings-release-notes").getText(),
      "CCSM installed updater E2E candidate.",
    );
    await initialBrowser.saveScreenshot(
      join(outputDirectory, `${options.variant}-available.png`),
    );
    await initialBrowser.$('[data-settings-action="upgrade"]').click();

    const exit = await waitForProcessExit(initialProcess, 180_000);
    initialBrowser = undefined;
    let installerExitCode = null;
    let windowsHandoff = null;
    if (process.platform === "win32") {
      windowsHandoff = await waitForWindowsHandoff(windowsHandoffPath, 10_000);
      assert.deepEqual(windowsHandoff.arguments, ["/P", "/UPDATE", "/R"]);
      assert.equal(
        resolve(windowsHandoff.executablePath).toLowerCase(),
        appBinary.toLowerCase(),
      );
      assert.equal(
        fileSha256(windowsHandoff.installerPath),
        fileSha256(updateArtifact),
        "verified handoff bytes differ from the signed candidate",
      );
      installerProcess = spawn(
        windowsHandoff.installerPath,
        windowsHandoff.arguments,
        {
          env: process.env,
          stdio: ["ignore", logFd, logFd],
          windowsHide: false,
        },
      );
      const installerExit = await waitForProcessExit(installerProcess, 120_000);
      installerExitCode = installerExit.code;
      assert.equal(installerExitCode, 0, "NSIS updater exited unsuccessfully");
      automaticRestart = await waitForWindowsRestart(
        appBinary,
        initialPid,
        60_000,
      );
      await closeWindowsProcess(automaticRestart.processId);
      await waitForNoWindowsProcess(appBinary, 30_000);
      verificationProcess = spawn(appBinary, appArguments, {
        env: environment,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      await waitForDriver(
        options.driverPort,
        true,
        120_000,
        verificationProcess,
      );
    } else {
      await waitForDriver(options.driverPort, true, 180_000);
    }
    restartedBrowser = await connectDriver(options.driverPort, appBinary);
    await waitForApplication(restartedBrowser);

    const restartedVersion = await openSettings(restartedBrowser);
    assert.equal(
      restartedVersion,
      `Current version ${options.candidateVersion}`,
    );
    const restartedTheme = await restartedBrowser.execute(
      () => document.documentElement.dataset.theme,
    );
    const themePersisted = restartedTheme === "dark";
    if (process.platform !== "win32") {
      assert.equal(
        restartedTheme,
        "dark",
        "theme persisted across the updater restart",
      );
    }
    assert.ok(existsSync(join(dataDirectory, "data.db")));
    assert.equal(readFileSync(dataSentinelPath, "utf8"), dataSentinel);
    await restartedBrowser.$('[data-settings-action="check"]').click();
    await restartedBrowser.waitUntil(
      async () =>
        (await restartedBrowser.$(".settings-update-status").getText()) ===
        "CCSM is up to date.",
      { timeout: 30_000, timeoutMsg: "restarted version was not current" },
    );
    await restartedBrowser.saveScreenshot(
      join(outputDirectory, `${options.variant}-restarted.png`),
    );

    const requestPaths = requestRecords.map((record) => record.path);
    assertInstalledUpdateRequestTrace(requestPaths, artifactName);
    result = {
      variant: options.variant,
      target: options.target,
      baseVersion: options.baseVersion,
      candidateVersion: options.candidateVersion,
      initialPid,
      initialExitCode: exit.code,
      initialExitSignal: exit.signal,
      installerExitCode,
      windowsHandoff,
      automaticRestartPid: automaticRestart?.processId ?? null,
      automaticRestartCommandLine: automaticRestart?.commandLine ?? null,
      postUpdateSession:
        process.platform === "win32" ? "controlled-relaunch" : "reconnected",
      restartObserved: true,
      themePersisted: process.platform === "win32" ? null : themePersisted,
      themePersistenceAsserted: process.platform !== "win32",
      restartedTheme,
      dataPersisted: true,
      requestRecords,
      passed: true,
    };

    await closeApplication(restartedBrowser, options.driverPort);
    restartedBrowser = undefined;
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    result = {
      variant: options.variant,
      target: options.target,
      baseVersion: options.baseVersion,
      candidateVersion: options.candidateVersion,
      restartObserved: false,
      requestRecords,
      windowsHandoffDiagnostics:
        process.platform === "win32"
          ? readWindowsHandoffDiagnostics(initialProcess?.pid)
          : [],
      passed: false,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    throw error;
  } finally {
    await safeDeleteSession(initialBrowser);
    if (restartedBrowser) {
      try {
        await closeApplication(restartedBrowser, options.driverPort);
      } catch {
        await safeDeleteSession(restartedBrowser);
      }
    }
    if (initialProcess && initialProcess.exitCode === null) {
      initialProcess.kill("SIGTERM");
    }
    if (installerProcess && installerProcess.exitCode === null) {
      installerProcess.kill("SIGTERM");
    }
    if (verificationProcess && verificationProcess.exitCode === null) {
      verificationProcess.kill("SIGTERM");
    }
    await closeServer(server);
    closeSync(logFd);
  }
}

function createUpdateServer({
  port,
  artifactName,
  artifactPath,
  signature,
  target,
  version,
  requestRecords,
}) {
  const encodedArtifactName = encodeURIComponent(artifactName);
  const endpointRoot = `http://127.0.0.1:${port}`;
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", endpointRoot);
    const record = (status) => {
      requestRecords.push({
        method: request.method ?? "GET",
        path: url.pathname,
        status,
        at: new Date().toISOString(),
      });
    };

    if (url.pathname === "/unavailable/latest.json") {
      record(503);
      response.writeHead(503).end("unavailable");
      return;
    }
    if (
      url.pathname === "/primary/latest.json" ||
      url.pathname === "/fallback/latest.json"
    ) {
      const primary = url.pathname.startsWith("/primary/");
      const artifactUrl = primary
        ? `${endpointRoot}/primary/${encodedArtifactName}`
        : `${endpointRoot}/artifacts/${encodedArtifactName}`;
      const body = JSON.stringify(
        createInstalledUpdateManifest({
          version,
          target,
          artifactUrl,
          signature,
        }),
      );
      record(200);
      response.writeHead(200, {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/json",
      });
      response.end(body);
      return;
    }
    if (url.pathname === `/primary/${encodedArtifactName}`) {
      record(503);
      response.writeHead(503).end("primary artifact unavailable");
      return;
    }
    if (url.pathname === `/artifacts/${encodedArtifactName}`) {
      record(200);
      response.writeHead(200, {
        "Content-Length": statSync(artifactPath).size,
        "Content-Type": "application/octet-stream",
      });
      createReadStream(artifactPath).pipe(response);
      return;
    }
    record(404);
    response.writeHead(404).end("not found");
  });
}

function installedAppEnvironment(dataDirectory, driverPort) {
  const environment = {
    ...process.env,
    CCSM_DATA_DIR: dataDirectory,
    CCSM_ENABLE_UPDATER: "1",
    TAURI_WEBDRIVER_PORT: String(driverPort),
    WDIO_EMBEDDED_SERVER: "true",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    RUST_LOG: "tauri_plugin_updater=debug,ccsm_desktop=debug",
  };
  if (process.platform !== "win32") {
    environment.XDG_CACHE_HOME = join(dataDirectory, "cache");
    environment.XDG_CONFIG_HOME = join(dataDirectory, "config");
    environment.XDG_DATA_HOME = join(dataDirectory, "data");
    environment.LIBGL_ALWAYS_SOFTWARE = "1";
    environment.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  }
  return environment;
}

async function connectDriver(port, appBinary) {
  let lastError;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    try {
      return await remote({
        hostname: "127.0.0.1",
        port,
        path: "/",
        logLevel: "silent",
        connectionRetryCount: 0,
        connectionRetryTimeout: 5_000,
        capabilities: {
          browserName: "tauri",
          "tauri:options": { application: appBinary },
        },
      });
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`could not connect to restarted WebDriver: ${lastError}`);
}

async function waitForApplication(browser) {
  await browser.$("#app").waitForDisplayed({ timeout: 60_000 });
  await browser.waitUntil(
    async () =>
      (await browser.$("#global-status").getAttribute("data-state")) ===
      "running",
    { timeout: 60_000, timeoutMsg: "CCSM bootstrap did not become ready" },
  );
  await browser.$("#settings-button").waitForClickable({ timeout: 20_000 });
  await browser.setWindowRect(20, 20, 1320, 800);
}

async function openSettings(browser) {
  await browser.$("#settings-button").click();
  await browser.$(".settings-dialog").waitForDisplayed({ timeout: 20_000 });
  return browser.$(".settings-update-version").getText();
}

async function closeApplication(browser, driverPort) {
  try {
    await browser.$('[data-window-action="close"]').click();
  } catch {
    // The WebDriver connection can close while the click response is in flight.
  }
  await waitForDriver(driverPort, false, 30_000);
}

async function safeDeleteSession(browser) {
  if (!browser?.sessionId) return;
  try {
    await browser.deleteSession();
  } catch {
    // An updater restart intentionally destroys the active WebDriver session.
  }
}

async function waitForDriver(port, expectedReady, timeoutMs, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child && child.exitCode !== null && expectedReady) {
      throw new Error(
        `installed application exited before WebDriver was ready: ${child.exitCode}`,
      );
    }
    const ready = await driverReady(port);
    if (ready === expectedReady) return;
    await delay(waitStepMs);
  }
  throw new Error(
    `WebDriver on port ${port} did not become ${expectedReady ? "ready" : "closed"}`,
  );
}

async function driverReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.value?.ready === true;
  } catch {
    return false;
  }
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("installed application did not exit for update"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForWindowsHandoff(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    await delay(100);
  }
  throw new Error("installed application did not publish its updater handoff");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function waitForWindowsRestart(appBinary, previousPid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const candidate = windowsProcessesForExecutable(appBinary).find(
      (process_) => process_.processId !== previousPid,
    );
    if (candidate) {
      await delay(2_000);
      const stable = windowsProcessesForExecutable(appBinary).find(
        (process_) => process_.processId === candidate.processId,
      );
      if (stable) return stable;
    }
    await delay(500);
  }
  throw new Error("NSIS update did not automatically restart CCSM");
}

async function waitForNoWindowsProcess(appBinary, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (windowsProcessesForExecutable(appBinary).length === 0) return;
    await delay(250);
  }
  throw new Error("automatically restarted CCSM did not close cleanly");
}

function windowsProcessesForExecutable(appBinary) {
  const command = [
    "$target = [IO.Path]::GetFullPath($env:CCSM_UPDATE_E2E_APP_BINARY)",
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'ccsm-desktop.exe'\" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -eq $target) } | Select-Object ProcessId, CommandLine)",
    "if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env: { ...process.env, CCSM_UPDATE_E2E_APP_BINARY: appBinary },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`list restarted CCSM processes failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((entry) => ({
    processId: Number(entry.ProcessId),
    commandLine: entry.CommandLine ?? null,
  }));
}

function closeWindowsProcess(processId) {
  const command = [
    "$process = Get-Process -Id ([int]$env:CCSM_UPDATE_E2E_PROCESS_ID) -ErrorAction Stop",
    "[void]$process.CloseMainWindow()",
    "if (-not $process.WaitForExit(20000)) { exit 2 }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CCSM_UPDATE_E2E_PROCESS_ID: String(processId),
      },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `close automatically restarted CCSM failed: ${result.stderr}`,
    );
  }
}

function readWindowsHandoffDiagnostics(initialPid) {
  if (!initialPid) return [];
  try {
    const prefix = `ccsm-${initialPid}-`;
    const directories = readdirSync(tmpdir(), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(prefix),
    );
    const diagnostics = [];
    for (const directory of directories) {
      const root = join(tmpdir(), directory.name);
      for (const name of ["CCSM-update-status.log", "CCSM-update-error.log"]) {
        const path = join(root, name);
        if (existsSync(path)) {
          diagnostics.push({
            directory: directory.name,
            name,
            text: readFileSync(path, "utf8"),
          });
        }
      }
    }
    return diagnostics;
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

function requiredFile(path, label) {
  const value = resolve(path);
  if (!existsSync(value) || !statSync(value).isFile()) {
    throw new Error(`${label} does not exist: ${value}`);
  }
  return value;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArguments(values) {
  const arguments_ = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    arguments_.set(name.slice(2), value);
  }
  const required = [
    "app-binary",
    "update-artifact",
    "update-signature",
    "target",
    "base-version",
    "candidate-version",
    "endpoint-port",
    "driver-port",
    "data-dir",
    "output-dir",
    "variant",
  ];
  for (const name of required) {
    if (!arguments_.has(name)) throw new Error(`--${name} is required`);
  }
  return {
    appBinary: arguments_.get("app-binary"),
    updateArtifact: arguments_.get("update-artifact"),
    updateSignature: arguments_.get("update-signature"),
    target: arguments_.get("target"),
    baseVersion: arguments_.get("base-version"),
    candidateVersion: arguments_.get("candidate-version"),
    endpointPort: Number(arguments_.get("endpoint-port")),
    driverPort: Number(arguments_.get("driver-port")),
    dataDirectory: arguments_.get("data-dir"),
    outputDirectory: arguments_.get("output-dir"),
    variant: arguments_.get("variant"),
  };
}

async function main() {
  try {
    const result = await runInstalledUpdateE2e(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
