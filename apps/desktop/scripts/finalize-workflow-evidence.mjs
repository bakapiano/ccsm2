import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";

const artifactDirectory = resolve(requiredValue("CCSM_E2E_ARTIFACT_DIR"));
const platform = requiredValue("CCSM_E2E_PLATFORM");
const workflowStatus = process.env.CCSM_E2E_JOB_STATUS ?? "unknown";
const stepOutcomes = parseStepOutcomes();
const failedStep = Object.entries(stepOutcomes).find(
  ([, outcome]) => outcome === "failure" || outcome === "cancelled",
)?.[0];
const resultPath = join(artifactDirectory, "result.json");
const displayProcesses = platform === "linux" ? listXvfbProcesses() : [];
const displayClean = displayProcesses.length === 0;

mkdirSync(artifactDirectory, { recursive: true });
writeJson(join(artifactDirectory, "display-cleanup.json"), {
  platform,
  checkedAt: new Date().toISOString(),
  clean: displayClean,
  processes: displayProcesses,
});

let results = readResults();
if (results.length === 0) {
  results.push(
    workflowFailure(
      failedStep ? `workflow-${failedStep}` : "workflow-finalize",
      failedStep
        ? `GitHub Actions step ${failedStep} ended with ${stepOutcomes[failedStep]}`
        : "Desktop runner produced no result.json",
    ),
  );
}
if (workflowStatus !== "success" && results.every(isPassed)) {
  results.push(
    workflowFailure(
      failedStep ? `workflow-${failedStep}` : "workflow-step",
      failedStep
        ? `GitHub Actions step ${failedStep} ended with ${stepOutcomes[failedStep]}`
        : `GitHub Actions job reached finalization with status ${workflowStatus}`,
    ),
  );
}
if (!displayClean && results.every(isPassed)) {
  results.push(
    workflowFailure(
      "display-cleanup",
      `Xvfb cleanup left ${displayProcesses.length} process(es)`,
    ),
  );
}
const processCleanupPath = join(artifactDirectory, "process-cleanup.json");
if (!existsSync(processCleanupPath)) {
  writeJson(processCleanupPath, {
    checkedAt: new Date().toISOString(),
    clean: null,
    gracefulCleanup: null,
    status: "runner-not-started",
    observedBeforeTermination: [],
    lingeringProcesses: [],
  });
}
const providerContractPath = join(
  artifactDirectory,
  "provider-cli-contract.json",
);
if (!existsSync(providerContractPath)) {
  writeJson(providerContractPath, {
    schemaVersion: 1,
    status:
      stepOutcomes.provider_contract === "skipped" ? "not-run" : "unavailable",
    platform,
    completedAt: new Date().toISOString(),
    checks: [],
    packages: [],
  });
}
writeJson(resultPath, results);

const existingCredentialScan = readJson(
  join(artifactDirectory, "credential-scan.json"),
);
const credentialFindings = [
  ...(Array.isArray(existingCredentialScan?.findings)
    ? existingCredentialScan.findings
    : []),
  ...sanitizeTextArtifacts(),
];
const credentialClean = credentialFindings.length === 0;
writeJson(join(artifactDirectory, "credential-scan.json"), {
  clean: credentialClean,
  findings: credentialFindings,
});
if (!credentialClean && results.every(isPassed)) {
  results.push(
    workflowFailure(
      "credential-scan",
      `Artifact credential scan matched ${credentialFindings.length} file(s)`,
    ),
  );
  writeJson(resultPath, results);
}

const processCleanup = readJson(processCleanupPath);
const providerContract = readJson(providerContractPath);
const processClean = processCleanup?.clean === true;
const providerContractPassed = providerContract?.status === "passed";
if (!processClean && results.every(isPassed)) {
  results.push(
    workflowFailure(
      "process-cleanup",
      "Desktop process cleanup did not report a clean result",
    ),
  );
}
if (!providerContractPassed && results.every(isPassed)) {
  results.push(
    workflowFailure(
      "provider-contract",
      `Provider CLI contract status is ${providerContract?.status ?? "missing"}`,
    ),
  );
}
writeJson(resultPath, results);

const finalStatus =
  workflowStatus === "success" &&
  displayClean &&
  credentialClean &&
  processClean &&
  providerContractPassed &&
  results.every(isPassed)
    ? "passed"
    : "failed";
writeJson(join(artifactDirectory, "workflow-state.json"), {
  platform,
  workflowStatus,
  stepOutcomes,
  finalStatus,
  finalizedAt: new Date().toISOString(),
});
writeManifest(finalStatus, results, {
  credentialClean,
  processClean,
  providerContractPassed,
});

if (finalStatus === "failed" && workflowStatus === "success") {
  process.exitCode = 1;
}

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseStepOutcomes() {
  try {
    const parsed = JSON.parse(process.env.CCSM_E2E_STEP_OUTCOMES ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readResults() {
  if (!existsSync(resultPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isPassed(result) {
  return result.state === "passed";
}

function workflowFailure(failureStep, error) {
  return {
    scenarioId: "workflow",
    title: "Desktop E2E workflow",
    fullTitle: "Desktop E2E workflow finalization",
    state: "failed",
    durationMs: 0,
    failureStep,
    error,
  };
}

function listXvfbProcesses() {
  try {
    return execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => /(?:^|[\s/])Xvfb(?:\s|$)/.test(line))
      .map((line) => line.trim());
  } catch (error) {
    return [`inspection failed: ${error.message}`];
  }
}

function writeManifest(finalStatus, results, status) {
  const manifestPath = join(artifactDirectory, "manifest.json");
  const existing = readJson(manifestPath) ?? {};
  const manifest = {
    ...existing,
    runId: existing.runId ?? process.env.CCSM_E2E_RUN_ID ?? null,
    commitSha: existing.commitSha ?? process.env.GITHUB_SHA ?? null,
    platform,
    architecture: existing.architecture ?? process.arch,
    workflowRunId: existing.workflowRunId ?? process.env.GITHUB_RUN_ID ?? null,
    finalStatus,
    workflowStatus,
    stepOutcomes,
    displayCleanup: { clean: displayClean },
    credentialScan: { clean: status.credentialClean },
    processCleanup: { clean: status.processClean },
    providerCliContract: { passed: status.providerContractPassed },
    scenarios: results.map((result) => ({
      scenarioId: result.scenarioId,
      fullTitle: result.fullTitle,
      state: result.state,
      durationMs: result.durationMs,
      ...(result.failureStep ? { failureStep: result.failureStep } : {}),
    })),
    generatedAt: new Date().toISOString(),
  };
  manifest.files = walkFiles(artifactDirectory)
    .filter((path) => basename(path) !== "manifest.json")
    .map((path) => ({
      path: relative(artifactDirectory, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
  writeJson(manifestPath, manifest);
}

function sanitizeTextArtifacts() {
  const findings = [];
  const credentialPatterns = [
    [
      "github-token",
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    ],
    ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ["bearer-token", /(Authorization[\s=:"']+Bearer\s+)[^\s,"']+/gi],
    [
      "named-secret",
      /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*[\s=:"']+)[^\s,"']+/g,
    ],
  ];
  const replacementSources = [
    process.env.GITHUB_WORKSPACE,
    process.env.RUNNER_TEMP,
    process.env.CCSM_PROVIDER_CLI_ROOT,
    process.env.USERPROFILE,
    process.env.HOME,
  ].filter(Boolean);
  for (const path of walkFiles(artifactDirectory)) {
    if (!/\.(?:json|jsonl|log|txt|xml)$/iu.test(path)) continue;
    if (basename(path) === "manifest.json") continue;
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
    for (const source of replacementSources) {
      for (const variant of new Set([
        source,
        source.replaceAll("\\", "/"),
        source.replaceAll("\\", "\\\\"),
      ])) {
        contents = contents.replaceAll(variant, "<RUNNER_PATH>");
      }
    }
    contents = contents
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        "<REDACTED_GITHUB_TOKEN>",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<REDACTED_OPENAI_KEY>")
      .replace(/(Authorization[\s=:"']+Bearer\s+)[^\s,"']+/gi, "$1<REDACTED>")
      .replace(
        /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*[\s=:"']+)[^\s,"']+/g,
        "$1<REDACTED>",
      );
    writeFileSync(path, contents);
  }
  return findings;
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
