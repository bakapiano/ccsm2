import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const fixtureRoot = join(desktopRoot, "e2e", "provider-cli-contract");
const platform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "linux"
      ? "linux"
      : process.platform;
const architecture = process.arch;
const artifactDirectory = resolve(
  process.env.CCSM_E2E_ARTIFACT_DIR ??
    join(repositoryRoot, "test-results", "provider-cli-contract", platform),
);
const resultPath = join(artifactDirectory, "provider-cli-contract.json");
const configuredInstallRoot = process.env.CCSM_PROVIDER_CLI_ROOT;
const localInstallParent = join(repositoryRoot, "test-results");
mkdirSync(localInstallParent, { recursive: true });
const installRoot = configuredInstallRoot
  ? resolve(configuredInstallRoot)
  : mkdtempSync(join(localInstallParent, `.provider-clis-${platform}-`));
const cleanupInstallRoot = !configuredInstallRoot;
const runtimeRootParent = resolve(
  process.env.CCSM_E2E_RUNTIME_PARENT ??
    join(repositoryRoot, "..", ".ccsm-e2e-runtime"),
);
mkdirSync(runtimeRootParent, { recursive: true });
const contractRuntimeRoot = mkdtempSync(
  join(runtimeRootParent, `.provider-contract-${platform}-`),
);
const contractWorkingDirectory = join(contractRuntimeRoot, "workspace");
const executionHome = join(contractRuntimeRoot, "home");
const binaryName =
  process.platform === "win32" ? "ccsm-desktop.exe" : "ccsm-desktop";
const appBinary = resolve(
  process.env.CCSM_E2E_APP_BINARY ??
    join(repositoryRoot, "target", "debug", binaryName),
);
const packageManifest = JSON.parse(
  readFileSync(join(fixtureRoot, "package.json"), "utf8"),
);
const packageLockPath = join(fixtureRoot, "package-lock.json");
const lockSha256 = createHash("sha256")
  .update(readFileSync(packageLockPath))
  .digest("hex");
const providerEnvironmentPath = join(
  installRoot,
  "provider-cli-environment.json",
);
const startedAt = new Date().toISOString();
const checks = [];
const packages = [];
let finalStatus = "failed";
let finalError;
let modelStub;

mkdirSync(artifactDirectory, { recursive: true });
mkdirSync(installRoot, { recursive: true });
mkdirSync(contractWorkingDirectory, { recursive: true });
mkdirSync(executionHome, { recursive: true });

try {
  assertSupportedTarget();
  assertFile(appBinary, "E2E executable");
  rmSync(providerEnvironmentPath, { force: true });
  installPinnedPackages();

  const providers = providerDefinitions();
  for (const provider of providers) {
    await inspectProvider(provider);
  }
  const wrapperContext = runWrapperContracts(providers);
  modelStub = await startModelStub();
  runRealModelContracts(providers, wrapperContext, modelStub.port);
  writeProviderEnvironment(providers);
  finalStatus = "passed";
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error);
  console.error(finalError);
} finally {
  if (modelStub) {
    try {
      await stopModelStub(modelStub.child);
    } catch (error) {
      finalStatus = "failed";
      finalError ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (cleanupInstallRoot && process.env.CCSM_PROVIDER_CLI_KEEP !== "1") {
    try {
      const resolvedRoot = realpathSync(installRoot);
      const resolvedInstallParent = realpathSync(localInstallParent);
      const installPrefix = `${resolvedInstallParent}${process.platform === "win32" ? "\\" : "/"}`;
      if (!resolvedRoot.startsWith(installPrefix)) {
        throw new Error(
          `refusing to remove provider CLI root outside test-results: ${resolvedRoot}`,
        );
      }
      rmSync(resolvedRoot, { recursive: true, force: true });
    } catch (error) {
      finalStatus = "failed";
      finalError ??= `remove provider CLI runtime: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  try {
    removeContractRuntimeRoot();
  } catch (error) {
    finalStatus = "failed";
    finalError ??= `remove provider contract runtime: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (finalStatus !== "passed") {
    rmSync(providerEnvironmentPath, { force: true });
  }
  writeResult();
}

if (finalStatus !== "passed") process.exit(1);

function assertSupportedTarget() {
  if (
    !(["win32", "linux"].includes(process.platform) && process.arch === "x64")
  ) {
    throw new Error(
      `provider CLI contract supports win32-x64 and linux-x64; received ${process.platform}-${process.arch}`,
    );
  }
}

function installPinnedPackages() {
  for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
    copyFileSync(join(fixtureRoot, name), join(installRoot, name));
  }
  const npmArguments = [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ];
  let npmProgram = "npm";
  if (process.platform === "win32") {
    const npmCli = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    assertFile(npmCli, "npm CLI");
    npmProgram = process.execPath;
    npmArguments.unshift(npmCli);
  }
  const started = Date.now();
  const result = spawnSync(npmProgram, npmArguments, {
    cwd: installRoot,
    env: installEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  recordCheck({
    id: "install-pinned-provider-clis",
    kind: "download",
    durationMs: Date.now() - started,
    result,
    expectedStatus: 0,
  });
}

function installEnvironment() {
  const environment = {
    ...cleanEnvironment(),
    ...selectedHostEnvironment([
      "ALL_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
    ]),
  };
  return {
    ...environment,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_cache: join(installRoot, ".npm-cache"),
    npm_config_userconfig: join(installRoot, ".npmrc"),
  };
}

function providerDefinitions() {
  const platformPackages =
    process.platform === "win32"
      ? {
          claude: {
            name: "@anthropic-ai/claude-code-win32-x64",
            binary: ["claude.exe"],
            observedVersion: "2.1.233 (Claude Code)",
            sha256:
              "8ae35d41252b02a7b747097ececf368b6872fab93ca104832b99a8ec5942fabd",
          },
          codex: {
            name: "@openai/codex-win32-x64",
            binary: ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
            observedVersion: "codex-cli 0.147.0",
            sha256:
              "935a1911ed2556e4ffcec995f4886ac2ac425863ba26fed264df62e30272ad9d",
          },
          copilot: {
            name: "@github/copilot-win32-x64",
            binary: ["copilot.exe"],
            observedVersion: "GitHub Copilot CLI 1.0.80.",
            sha256:
              "4f590f1f60f3f2bd4cf731cddf50360672d3c97d93150bd05ffa496d65e326f8",
          },
        }
      : {
          claude: {
            name: "@anthropic-ai/claude-code-linux-x64",
            binary: ["claude"],
            observedVersion: "2.1.233 (Claude Code)",
            sha256:
              "55d281096f57d411ebbdd94dbf5e9ff3accb7c05713e37348c2c11d4b83bf9d9",
          },
          codex: {
            name: "@openai/codex-linux-x64",
            binary: ["vendor", "x86_64-unknown-linux-musl", "bin", "codex"],
            observedVersion: "codex-cli 0.147.0",
            sha256:
              "cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40",
          },
          copilot: {
            name: "@github/copilot-linux-x64",
            binary: ["copilot"],
            observedVersion: "GitHub Copilot CLI 1.0.80.",
            sha256:
              "2ebb491db8bbbad58fb111a34b3f92798da44341976e5a6021bc13c7e57ae9e6",
          },
        };

  return [
    {
      provider: "claude",
      packageName: "@anthropic-ai/claude-code",
      expectedVersion:
        packageManifest.dependencies["@anthropic-ai/claude-code"],
      platformPackage: platformPackages.claude,
      versionArguments: ["--version"],
      versionPattern: /Claude Code/i,
      helpArguments: ["--help"],
      helpTokens: ["--resume", "--session-id", "--settings"],
      realPathVariable: "CCSM_REAL_CLAUDE_PATH",
    },
    {
      provider: "codex",
      packageName: "@openai/codex",
      expectedVersion: packageManifest.dependencies["@openai/codex"],
      platformPackage: platformPackages.codex,
      versionArguments: ["--version"],
      versionPattern: /codex-cli/i,
      helpArguments: ["resume", "--help"],
      helpTokens: ["SESSION_ID", "--last", "--config"],
      realPathVariable: "CCSM_REAL_CODEX_PATH",
    },
    {
      provider: "copilot",
      packageName: "@github/copilot",
      expectedVersion: packageManifest.dependencies["@github/copilot"],
      platformPackage: platformPackages.copilot,
      versionArguments: ["--version"],
      versionPattern: /GitHub Copilot CLI/i,
      helpArguments: ["--help"],
      helpTokens: ["--resume", "--plugin-dir", "--session-id"],
      realPathVariable: "CCSM_REAL_COPILOT_PATH",
    },
  ].map((provider) => ({
    ...provider,
    expectedObservedVersion: provider.platformPackage.observedVersion,
    expectedSha256: provider.platformPackage.sha256,
    binary: join(
      installRoot,
      "node_modules",
      ...provider.platformPackage.name.split("/"),
      ...provider.platformPackage.binary,
    ),
  }));
}

function writeProviderEnvironment(providers) {
  writeFileSync(
    providerEnvironmentPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform,
        architecture,
        lockSha256,
        providers: Object.fromEntries(
          providers.map((provider) => [provider.provider, provider.binary]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function inspectProvider(provider) {
  const mainPackage = readInstalledPackage(provider.packageName);
  const platformPackage = readInstalledPackage(provider.platformPackage.name);
  if (mainPackage.version !== provider.expectedVersion) {
    throw new Error(
      `${provider.provider} resolved ${mainPackage.version}; expected ${provider.expectedVersion}`,
    );
  }
  if (!platformPackage.version.startsWith(provider.expectedVersion)) {
    throw new Error(
      `${provider.platformPackage.name} resolved ${platformPackage.version}; expected ${provider.expectedVersion}`,
    );
  }
  assertFile(provider.binary, `${provider.provider} executable`);
  if (process.platform !== "win32") chmodSync(provider.binary, 0o755);

  const version = runCommandCheck({
    id: `${provider.provider}-version`,
    provider: provider.provider,
    kind: "version",
    program: provider.binary,
    args: provider.versionArguments,
    environment: providerInspectionEnvironment(provider.provider),
    requiredPatterns: [
      provider.versionPattern,
      new RegExp(`^${escapeRegex(provider.expectedObservedVersion)}$`, "m"),
    ],
  });
  runCommandCheck({
    id: `${provider.provider}-resume-interface`,
    provider: provider.provider,
    kind: "resume-interface",
    program: provider.binary,
    args: provider.helpArguments,
    environment: providerInspectionEnvironment(provider.provider),
    requiredTokens: provider.helpTokens,
  });
  const executableSha256 = await sha256File(provider.binary);
  const integrityCheck = {
    id: `${provider.provider}-binary-integrity`,
    provider: provider.provider,
    kind: "binary-integrity",
    status: executableSha256 === provider.expectedSha256 ? "passed" : "failed",
    durationMs: 0,
    exitCode: 0,
    output: JSON.stringify({
      expectedSha256: provider.expectedSha256,
      observedSha256: executableSha256,
    }),
  };
  checks.push(integrityCheck);
  if (integrityCheck.status !== "passed") {
    throw new Error(`${provider.provider} native executable SHA-256 changed`);
  }
  packages.push({
    provider: provider.provider,
    package: provider.packageName,
    pinnedVersion: provider.expectedVersion,
    platformPackage: provider.platformPackage.name,
    platformPackageVersion: platformPackage.version,
    expectedNativeVersion: provider.expectedObservedVersion,
    observedVersion: firstNonEmptyLine(version.output),
    executable: basename(provider.binary),
    expectedSha256: provider.expectedSha256,
    sha256: executableSha256,
  });
}

function providerInspectionEnvironment(provider) {
  const environment = executionEnvironment();
  if (provider !== "copilot") return environment;
  return {
    ...environment,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_OFFLINE: "true",
  };
}

function runWrapperContracts(providers) {
  const contractRoot = join(contractRuntimeRoot, "ccsm-wrapper-contract");
  rmSync(contractRoot, { recursive: true, force: true });
  const pluginRoot = join(contractRoot, "copilot-hook-plugin");
  const wrapperName =
    process.platform === "win32" ? "ccsm-provider.exe" : "ccsm-provider";
  const wrapper = join(contractRoot, wrapperName);
  mkdirSync(pluginRoot, { recursive: true });
  const hook = createHookReporter(contractRoot);
  const argvCapture = createArgumentCapture(contractRoot);
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "ccsm-provider-contract", version: "1.0.0", hooks: "hooks.json" }, null, 2)}\n`,
  );
  writeFileSync(
    join(pluginRoot, "hooks.json"),
    `${JSON.stringify(
      {
        version: 1,
        hooks: Object.fromEntries(
          [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "SessionEnd",
          ].map((event) => [event, [copilotHookEntry(hook.command)]]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  linkOrCopy(appBinary, wrapper);
  if (process.platform !== "win32") chmodSync(wrapper, 0o755);

  for (const provider of providers) {
    const context = { argvCapture, contractRoot, hook, pluginRoot, wrapper };
    runCapturedWrapperCheck({
      id: `${provider.provider}-wrapper-cold`,
      provider,
      context,
      mode: "cold",
    });
    runCapturedWrapperCheck({
      id: `${provider.provider}-wrapper-resume`,
      provider,
      context,
      mode: "resume",
    });
  }
  return { argvCapture, contractRoot, hook, pluginRoot, wrapper };
}

function runCapturedWrapperCheck({ id, provider, context, mode }) {
  const nativeSessionId = "00000000-0000-4000-8000-000000000001";
  const marker = `ccsm-${provider.provider}-argv-probe`;
  const offset = readJsonLines(context.argvCapture.log).length;
  const check = runCommandCheck({
    id,
    provider: provider.provider,
    kind: `wrapper-${mode}`,
    program: context.wrapper,
    args: mode === "cold" ? [marker] : [],
    environment: {
      ...wrapperEnvironment(provider, context),
      [provider.realPathVariable]: context.argvCapture.command,
      CCSM_PROVIDER_ARGV_CAPTURE_LOG: context.argvCapture.log,
      ...(mode === "resume" ? { CCSM_NATIVE_SESSION_ID: nativeSessionId } : {}),
    },
  });
  try {
    const event = readJsonLines(context.argvCapture.log).slice(offset)[0];
    if (!event || event.provider !== provider.provider) {
      throw new Error(`${provider.provider} argv probe did not execute`);
    }
    const summary = assertWrapperArguments({
      provider: provider.provider,
      mode,
      marker,
      nativeSessionId,
      pluginRoot: context.pluginRoot,
      arguments: event.arguments,
    });
    check.output = JSON.stringify(summary);
  } catch (error) {
    check.status = "failed";
    check.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function assertWrapperArguments({
  provider,
  mode,
  marker,
  nativeSessionId,
  pluginRoot,
  arguments: args,
}) {
  if (!Array.isArray(args)) throw new Error(`${provider} argv is not an array`);
  if (mode === "cold" && args.at(-1) !== marker) {
    throw new Error(`${provider} cold argv lost the user argument`);
  }
  if (provider === "claude") {
    const selection = mode === "resume" ? "--resume" : "--session-id";
    const selectionIndex = args.indexOf(selection);
    if (selectionIndex < 0 || !args[selectionIndex + 1]) {
      throw new Error(`Claude ${mode} argv has no ${selection}`);
    }
    if (mode === "resume" && args[selectionIndex + 1] !== nativeSessionId) {
      throw new Error("Claude resume argv has the wrong native session ID");
    }
    if (
      mode === "cold" &&
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(args[selectionIndex + 1])
    ) {
      throw new Error("Claude cold argv has no generated UUID session ID");
    }
    const settingsIndex = args.indexOf("--settings");
    if (
      settingsIndex < 0 ||
      !args[settingsIndex + 1]?.includes("SessionStart")
    ) {
      throw new Error("Claude argv has no injected Hook settings");
    }
    return { mode, sessionFlag: selection, hooks: true };
  }
  if (provider === "codex") {
    if (
      args[0] !== "--enable" ||
      args[1] !== "hooks" ||
      !args.includes("--dangerously-bypass-hook-trust") ||
      !args.includes("--no-alt-screen")
    ) {
      throw new Error("Codex argv has no production Hook prelude");
    }
    const hookOverrides = args.filter((value) => value === "-c").length;
    if (hookOverrides !== 6) {
      throw new Error(
        `Codex argv has ${hookOverrides} Hook overrides; expected 6`,
      );
    }
    const resumeIndex = args.indexOf("resume");
    if (mode === "resume") {
      if (resumeIndex < 0 || args[resumeIndex + 1] !== nativeSessionId) {
        throw new Error("Codex resume argv has the wrong native session ID");
      }
    } else if (resumeIndex >= 0) {
      throw new Error("Codex cold argv unexpectedly selected resume");
    }
    return { mode, hookOverrides, resume: mode === "resume" };
  }
  if (args[0] !== "--plugin-dir" || args[1] !== pluginRoot) {
    throw new Error("Copilot argv has the wrong production Hook plugin");
  }
  const resume = `--resume=${nativeSessionId}`;
  if (mode === "resume" && !args.includes(resume)) {
    throw new Error("Copilot resume argv has the wrong native session ID");
  }
  if (mode === "cold" && args.some((value) => value.startsWith("--resume"))) {
    throw new Error("Copilot cold argv unexpectedly selected resume");
  }
  return { mode, plugin: true, resume: mode === "resume" };
}

function wrapperEnvironment(provider, context) {
  const environment = executionEnvironment();
  return {
    ...environment,
    PATH: `${context.contractRoot}${delimiter}${environment.PATH ?? ""}`,
    CCSM_PROVIDER: provider.provider,
    CCSM_SESSION_ID: `contract-${provider.provider}`,
    CCSM_RUNTIME_ID: `contract-${provider.provider}-runtime`,
    CCSM_HOOK_PIPE: "ccsm-provider-contract",
    CCSM_HOOK_TOKEN: "ccsm-provider-contract-token",
    CCSM_HOOK_REPORTER: context.hook.command,
    CCSM_HOOK_REPORTER_STRICT: "1",
    CCSM_PROVIDER_HOOK_STUB_LOG: context.hook.log,
    CCSM_COPILOT_PLUGIN_DIR: context.pluginRoot,
    [provider.realPathVariable]: provider.binary,
  };
}

function createHookReporter(contractRoot) {
  const log = join(contractRoot, "hook-events.jsonl");
  const script = join(contractRoot, "hook-reporter-stub.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      'const input = Buffer.concat(chunks).toString("utf8");',
      "let payload;",
      "try { payload = input ? JSON.parse(input) : null; } catch { payload = { raw: input }; }",
      "const event = { provider: process.env.CCSM_PROVIDER, arguments: process.argv.slice(2), payload };",
      "appendFileSync(process.env.CCSM_PROVIDER_HOOK_STUB_LOG, `${JSON.stringify(event)}\\n`);",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const command = join(contractRoot, "ccsm-hook.cmd");
    writeFileSync(
      command,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    return { command, log };
  }
  const command = join(contractRoot, "ccsm-hook");
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${shellSingleQuote(process.execPath)}' '${shellSingleQuote(script)}' "$@"\n`,
  );
  chmodSync(command, 0o755);
  return { command, log };
}

function createArgumentCapture(contractRoot) {
  const log = join(contractRoot, "provider-argv.jsonl");
  const script = join(contractRoot, "provider-argv-capture.mjs");
  writeFileSync(log, "");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "const event = { provider: process.env.CCSM_PROVIDER, arguments: process.argv.slice(2) };",
      "appendFileSync(process.env.CCSM_PROVIDER_ARGV_CAPTURE_LOG, `${JSON.stringify(event)}\\n`);",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const command = join(contractRoot, "provider-argv-capture.cmd");
    writeFileSync(
      command,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    return { command, log };
  }
  const command = join(contractRoot, "provider-argv-capture");
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${shellSingleQuote(process.execPath)}' '${shellSingleQuote(script)}' "$@"\n`,
  );
  chmodSync(command, 0o755);
  return { command, log };
}

function copilotHookEntry(command) {
  if (process.platform === "win32") {
    return {
      type: "command",
      powershell: `& '${command.replaceAll("'", "''")}' hook report`,
      timeoutSec: 10,
    };
  }
  return {
    type: "command",
    bash: `'${shellSingleQuote(command)}' hook report`,
    timeoutSec: 10,
  };
}

function startModelStub() {
  const logDirectory = join(artifactDirectory, "logs");
  const log = join(logDirectory, "provider-model-stub.jsonl");
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(log, "");
  const child = spawn(
    process.execPath,
    [join(scriptDirectory, "provider-model-stub.mjs")],
    {
      cwd: contractWorkingDirectory,
      env: {
        ...cleanEnvironment(),
        CCSM_PROVIDER_MODEL_STUB_KEY: "ccsm-provider-contract-key",
        CCSM_PROVIDER_MODEL_STUB_LOG: log,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolveStub, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `provider model stub did not become ready: ${sanitizeOutput(stderr)}`,
        ),
      );
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
      resolveStub({ child, log, port: Number(match[1]) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes("CCSM_PROVIDER_MODEL_STUB_READY")) {
        reject(
          new Error(
            `provider model stub exited with ${code}: ${sanitizeOutput(stderr)}`,
          ),
        );
      }
    });
  });
}

function stopModelStub(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("provider model stub did not stop within five seconds"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill();
  });
}

function runRealModelContracts(providers, context, port) {
  const byName = new Map(
    providers.map((provider) => [provider.provider, provider]),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const claude = byName.get("claude");
  const codex = byName.get("codex");
  const copilot = byName.get("copilot");
  const claudeSession = "11111111-1111-4111-8111-111111111111";
  const claudeColdPrompt = "CCSM_CLAUDE_REAL_CLI_COLD_PROMPT";
  const claudeResumePrompt = "CCSM_CLAUDE_REAL_CLI_RESUME_PROMPT";
  const hookOffset = readHookEvents(context.hook.log).length;
  const claudeEnvironment = {
    ...wrapperEnvironment(claude, context),
    ANTHROPIC_API_KEY: "ccsm-provider-contract-key",
    CCSM_CLAUDE_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };
  runCommandCheck({
    id: "claude-local-model-cold",
    provider: "claude",
    kind: "local-model",
    program: context.wrapper,
    args: [
      "--session-id",
      claudeSession,
      "-p",
      claudeColdPrompt,
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-4-5",
      "--permission-mode",
      "bypassPermissions",
    ],
    environment: claudeEnvironment,
    requiredTokens: [`CCSM_CLAUDE_REAL_CLI_RESPONSE:${claudeColdPrompt}`],
    timeoutMs: 120_000,
  });
  runCommandCheck({
    id: "claude-local-model-resume",
    provider: "claude",
    kind: "local-model-resume",
    program: context.wrapper,
    args: [
      "-p",
      claudeResumePrompt,
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-4-5",
      "--permission-mode",
      "bypassPermissions",
    ],
    environment: {
      ...claudeEnvironment,
      CCSM_NATIVE_SESSION_ID: claudeSession,
    },
    requiredTokens: [`CCSM_CLAUDE_REAL_CLI_RESPONSE:${claudeResumePrompt}`],
    timeoutMs: 120_000,
  });
  assertHookDelivery("claude", context.hook.log, hookOffset);
  assertResumeHookDelivery(
    "claude",
    context.hook.log,
    hookOffset,
    claudeSession,
  );

  const codexPrompt = "CCSM_CODEX_REAL_CLI_PROMPT";
  const codexResumePrompt = "CCSM_CODEX_REAL_CLI_RESUME_PROMPT";
  const codexHookOffset = readHookEvents(context.hook.log).length;
  const codexHome = join(executionHome, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "ccsm_local"',
      "",
      "[model_providers.ccsm_local]",
      'name = "CCSM local model stub"',
      `base_url = "${baseUrl}/v1"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  runCommandCheck({
    id: "codex-local-model",
    provider: "codex",
    kind: "local-model",
    program: context.wrapper,
    args: [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      codexPrompt,
    ],
    environment: {
      ...wrapperEnvironment(codex, context),
      OPENAI_API_KEY: "ccsm-provider-contract-key",
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      CODEX_HOME: codexHome,
    },
    requiredTokens: [`CCSM_CODEX_REAL_CLI_RESPONSE:${codexPrompt}`],
    timeoutMs: 120_000,
  });
  const codexSessionId = nativeSessionIdFromHooks(
    "codex",
    context.hook.log,
    codexHookOffset,
  );
  runCommandCheck({
    id: "codex-local-model-resume",
    provider: "codex",
    kind: "local-model-resume",
    program: context.wrapper,
    args: [
      "exec",
      "resume",
      "--skip-git-repo-check",
      codexSessionId,
      codexResumePrompt,
    ],
    environment: {
      ...wrapperEnvironment(codex, context),
      OPENAI_API_KEY: "ccsm-provider-contract-key",
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      CODEX_HOME: codexHome,
      CCSM_NATIVE_SESSION_ID: codexSessionId,
    },
    requiredTokens: [`CCSM_CODEX_REAL_CLI_RESPONSE:${codexResumePrompt}`],
    timeoutMs: 120_000,
  });
  assertHookDelivery("codex", context.hook.log, codexHookOffset);
  assertResumeHookDelivery(
    "codex",
    context.hook.log,
    codexHookOffset,
    codexSessionId,
  );

  const copilotColdPrompt = "CCSM_COPILOT_REAL_CLI_COLD_PROMPT";
  const copilotResumePrompt = "CCSM_COPILOT_REAL_CLI_RESUME_PROMPT";
  const copilotHookOffset = readHookEvents(context.hook.log).length;
  const copilotHome = join(executionHome, ".copilot");
  mkdirSync(copilotHome, { recursive: true });
  const copilotEnvironment = {
    ...wrapperEnvironment(copilot, context),
    COPILOT_HOME: copilotHome,
    COPILOT_OFFLINE: "true",
    COPILOT_ENABLE_ALT_PROVIDERS: "true",
    COPILOT_PROVIDER_BASE_URL: `${baseUrl}/copilot/v1`,
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_API_KEY: "ccsm-provider-contract-key",
    COPILOT_PROVIDER_WIRE_API: "responses",
    COPILOT_PROVIDER_TRANSPORT: "http",
    COPILOT_PROVIDER_MODEL_ID: "gpt-5.6-sol",
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    COPILOT_MODEL: "gpt-5.6-sol",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_DEBUG_SKIP_LAUNCH_CHECKS: "1",
    COPILOT_DISABLE_DESKTOP_NOTIFICATIONS: "1",
  };
  runCommandCheck({
    id: "copilot-local-model-cold",
    provider: "copilot",
    kind: "local-model",
    program: context.wrapper,
    args: ["-p", copilotColdPrompt],
    environment: copilotEnvironment,
    requiredTokens: [`CCSM_COPILOT_REAL_CLI_RESPONSE:${copilotColdPrompt}`],
    timeoutMs: 120_000,
  });
  const copilotSessionId = nativeSessionIdFromHooks(
    "copilot",
    context.hook.log,
    copilotHookOffset,
  );
  runCommandCheck({
    id: "copilot-local-model-resume",
    provider: "copilot",
    kind: "local-model-resume",
    program: context.wrapper,
    args: ["-p", copilotResumePrompt],
    environment: {
      ...copilotEnvironment,
      CCSM_NATIVE_SESSION_ID: copilotSessionId,
    },
    requiredTokens: [`CCSM_COPILOT_REAL_CLI_RESPONSE:${copilotResumePrompt}`],
    timeoutMs: 120_000,
  });
  assertHookDelivery("copilot", context.hook.log, copilotHookOffset);
  assertResumeHookDelivery(
    "copilot",
    context.hook.log,
    copilotHookOffset,
    copilotSessionId,
  );
}

function nativeSessionIdFromHooks(provider, logPath, offset) {
  const event = readHookEvents(logPath)
    .slice(offset)
    .find(
      (candidate) =>
        candidate.provider === provider &&
        (candidate.payload?.hook_event_name ??
          candidate.payload?.hookEventName) === "SessionStart",
    );
  const nativeSessionId =
    event?.payload?.session_id ?? event?.payload?.sessionId;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
    throw new Error(`${provider} real Hook did not report a native session ID`);
  }
  return nativeSessionId;
}

function assertHookDelivery(provider, logPath, offset) {
  const events = readHookEvents(logPath)
    .slice(offset)
    .filter((event) => event.provider === provider);
  const eventNames = events
    .map(
      (event) =>
        event.payload?.hook_event_name ??
        event.payload?.hookEventName ??
        event.payload?.event,
    )
    .filter(Boolean);
  const required = ["SessionStart", "UserPromptSubmit", "Stop"];
  const missing = required.filter((name) => !eventNames.includes(name));
  const check = {
    id: `${provider}-real-hook-delivery`,
    provider,
    kind: "hook-delivery",
    status: missing.length === 0 ? "passed" : "failed",
    durationMs: 0,
    exitCode: 0,
    output: JSON.stringify({ events: eventNames }),
  };
  checks.push(check);
  if (missing.length > 0) {
    throw new Error(
      `${provider} real Hook delivery missed ${missing.join(", ")}`,
    );
  }
}

function assertResumeHookDelivery(provider, logPath, offset, nativeSessionId) {
  const resumed = readHookEvents(logPath)
    .slice(offset)
    .find(
      (event) =>
        event.provider === provider &&
        (event.payload?.hook_event_name ?? event.payload?.hookEventName) ===
          "SessionStart" &&
        (event.payload?.session_id ?? event.payload?.sessionId) ===
          nativeSessionId &&
        event.payload?.source === "resume",
    );
  const check = {
    id: `${provider}-resume-hook`,
    provider,
    kind: "resume-hook",
    status: resumed ? "passed" : "failed",
    durationMs: 0,
    exitCode: 0,
    output: JSON.stringify({
      nativeSessionId,
      source: resumed?.payload?.source ?? null,
    }),
  };
  checks.push(check);
  if (!resumed) {
    throw new Error(
      `${provider} real resume Hook did not report source=resume for ${nativeSessionId}`,
    );
  }
}

function readHookEvents(path) {
  return readJsonLines(path);
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCommandCheck({
  id,
  provider,
  kind,
  program,
  args,
  environment = executionEnvironment(),
  requiredPatterns = [],
  requiredTokens = [],
  timeoutMs = 45_000,
  cwd = contractWorkingDirectory,
}) {
  const started = Date.now();
  const result = spawnSync(program, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const assertionOutput = sanitizeOutput(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    256_000,
  );
  const check = recordCheck({
    id,
    provider,
    kind,
    durationMs: Date.now() - started,
    result,
    expectedStatus: 0,
  });
  for (const pattern of requiredPatterns) {
    if (!pattern.test(assertionOutput)) {
      check.status = "failed";
      throw new Error(`${id} output did not match ${pattern}`);
    }
  }
  for (const token of requiredTokens) {
    if (!assertionOutput.includes(token)) {
      check.status = "failed";
      throw new Error(`${id} output did not contain ${token}`);
    }
  }
  return check;
}

function recordCheck({
  id,
  provider,
  kind,
  durationMs,
  result,
  expectedStatus,
}) {
  const output = sanitizeOutput(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  const status =
    result.status === expectedStatus && !result.error ? "passed" : "failed";
  const check = {
    id,
    ...(provider ? { provider } : {}),
    kind,
    status,
    durationMs,
    exitCode: result.status,
    output,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: sanitizeOutput(result.error.message) } : {}),
  };
  checks.push(check);
  if (status === "failed") {
    throw new Error(
      `${id} failed with exit code ${result.status}: ${check.error ?? lastNonEmptyLine(output)}`,
    );
  }
  return check;
}

function executionEnvironment() {
  const home = executionHome;
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...cleanEnvironment(),
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    GIT_CEILING_DIRECTORIES: runtimeRootParent,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
  };
}

function cleanEnvironment() {
  return selectedHostEnvironment([
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
  ]);
}

function selectedHostEnvironment(names) {
  const allowed = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      allowed.has(name.toUpperCase()),
    ),
  );
}

function readInstalledPackage(packageName) {
  const path = join(
    installRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  assertFile(path, `${packageName} manifest`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`);
}

function linkOrCopy(source, destination) {
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
}

function shellSingleQuote(value) {
  return value.replaceAll("'", "'\\''");
}

function removeContractRuntimeRoot() {
  const resolvedParent = realpathSync(runtimeRootParent);
  const resolvedRoot = realpathSync(contractRuntimeRoot);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (
    !resolvedRoot.startsWith(`${resolvedParent}${separator}`) ||
    !basename(resolvedRoot).startsWith(`.provider-contract-${platform}-`)
  ) {
    throw new Error(
      `refusing to remove unexpected provider contract runtime ${resolvedRoot}`,
    );
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function sanitizeOutput(value, maximumLength = 12_000) {
  const replacements = [
    [installRoot, "<PROVIDER_CLI_ROOT>"],
    [contractRuntimeRoot, "<PROVIDER_CONTRACT_RUNTIME>"],
    [repositoryRoot, "<REPOSITORY_ROOT>"],
    [process.env.USERPROFILE, "<USER_HOME>"],
    [process.env.HOME, "<USER_HOME>"],
  ].filter(([, replacement]) => replacement && replacement.length > 0);
  let output = String(value)
    .replaceAll("\0", "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  for (const [source, replacement] of replacements) {
    if (source) output = output.split(source).join(replacement);
  }
  return output.slice(0, maximumLength);
}

function writeResult() {
  const result = {
    schemaVersion: 1,
    status: finalStatus,
    platform,
    architecture,
    nodeVersion: process.version,
    registry: "https://registry.npmjs.org/",
    lockSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    credentials: "minimal host environment plus synthetic loopback API keys",
    modelNetwork:
      "provider model base URLs target the loopback stub; auxiliary HTTP clients receive a closed-loopback proxy",
    packages,
    checks,
    ...(finalError ? { error: sanitizeOutput(finalError) } : {}),
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Provider CLI contract ${finalStatus}: ${resultPath}`);
}

function firstNonEmptyLine(value) {
  return String(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function lastNonEmptyLine(value) {
  return String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
