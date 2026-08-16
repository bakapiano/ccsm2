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
      "workflow-finalize",
      "Desktop runner produced no result.json",
    ),
  );
}
if (workflowStatus !== "success" && results.every(isPassed)) {
  results.push(
    workflowFailure(
      "workflow-step",
      `GitHub Actions job reached finalization with status ${workflowStatus}`,
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
writeJson(resultPath, results);

const finalStatus =
  workflowStatus === "success" && displayClean && results.every(isPassed)
    ? "passed"
    : "failed";
writeJson(join(artifactDirectory, "workflow-state.json"), {
  platform,
  workflowStatus,
  finalStatus,
  finalizedAt: new Date().toISOString(),
});
updateManifest(finalStatus);

if (finalStatus === "failed" && workflowStatus === "success") {
  process.exitCode = 1;
}

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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

function updateManifest(finalStatus) {
  const manifestPath = join(artifactDirectory, "manifest.json");
  if (!existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  manifest.finalStatus = finalStatus;
  manifest.workflowStatus = workflowStatus;
  manifest.displayCleanup = { clean: displayClean };
  manifest.files = walkFiles(artifactDirectory)
    .filter((path) => basename(path) !== "manifest.json")
    .map((path) => ({
      path: relative(artifactDirectory, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
  writeJson(manifestPath, manifest);
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
