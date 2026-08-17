import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildE2eReport,
  installE2eReport,
  pruneE2eReports,
  removeE2eReport,
} from "./e2e-report-lib.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);
const temporaryRoots = [];

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds a complete escaped report from validated platform evidence", () => {
  const root = temporaryRoot();
  const artifacts = join(root, "artifacts");
  createEvidence(artifacts, "windows");
  createEvidence(artifacts, "linux");
  const jobs = join(root, "jobs.json");
  writeJson(jobs, {
    jobs: [
      {
        name: "Verify <img src=x onerror=alert(1)>",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-17T00:00:00Z",
        completed_at: "2026-08-17T00:00:10Z",
        html_url: "https://github.com/bakapiano/ccsm2/actions/jobs/1",
        steps: [
          {
            name: "Run <script>alert(1)</script>",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-17T00:00:01Z",
            completed_at: "2026-08-17T00:00:09Z",
          },
        ],
      },
    ],
  });
  const output = join(root, "report");
  const report = buildE2eReport({
    artifactsRoot: artifacts,
    outputRoot: output,
    workflowJobsPath: jobs,
    context: reportContext(42),
  });

  assert.equal(report.platforms.length, 2);
  assert.equal(report.platforms[0].platform, "windows");
  assert.equal(report.platforms[0].scenarios[0].screenshots.length, 2);
  assert.equal(report.platforms[0].providerContract.checks.length, 2);
  assert.ok(
    existsSync(
      join(
        output,
        "assets",
        "windows",
        "screenshots",
        "claude-resume",
        "001.png",
      ),
    ),
  );
  assert.ok(
    existsSync(
      join(output, "assets", "linux", "acceptance", "claude-resume.gif"),
    ),
  );
  assert.equal(existsSync(join(output, "logs", "backend.log")), false);

  const html = readFileSync(join(output, "index.html"), "utf8");
  assert.match(html, /Verify &lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /Run &lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /first &lt;checkpoint&gt;/u);
  assert.doesNotMatch(html, /<script>/u);

  const publicData = JSON.parse(
    readFileSync(join(output, "report.json"), "utf8"),
  );
  assert.equal(publicData.context.prNumber, 42);
  assert.equal(
    publicData.platforms[0].providerContract.checks[0].output,
    undefined,
  );
});

test("withholds public media when the credential scan is not clean", () => {
  const root = temporaryRoot();
  const artifacts = join(root, "artifacts");
  createEvidence(artifacts, "windows", { credentialClean: false });
  const report = buildE2eReport({
    artifactsRoot: artifacts,
    outputRoot: join(root, "report"),
    context: reportContext(42),
  });

  const windows = report.platforms.find(
    (entry) => entry.platform === "windows",
  );
  assert.equal(windows.mediaPublished, false);
  assert.equal(windows.media.gifs.length, 0);
  assert.equal(windows.media.screenshots.length, 0);
  assert.equal(existsSync(join(root, "report", "assets")), false);
});

test("rejects media whose contents diverge from the manifest", () => {
  const root = temporaryRoot();
  const artifacts = join(root, "artifacts");
  const evidenceRoot = createEvidence(artifacts, "windows");
  writeFileSync(
    join(evidenceRoot, "screenshots", "claude-resume", "001.png"),
    Buffer.concat([PNG, Buffer.from("tampered")]),
  );

  assert.throws(
    () =>
      buildE2eReport({
        artifactsRoot: artifacts,
        outputRoot: join(root, "report"),
        context: reportContext(42),
      }),
    /Artifact size mismatch/u,
  );
});

test("rejects manifest paths that escape the artifact root", () => {
  const root = temporaryRoot();
  const artifacts = join(root, "artifacts");
  const evidenceRoot = createEvidence(artifacts, "windows");
  const manifestPath = join(evidenceRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    path: "../outside.png",
    bytes: PNG.length,
    sha256: sha256(PNG),
  });
  writeJson(manifestPath, manifest);

  assert.throws(
    () =>
      buildE2eReport({
        artifactsRoot: artifacts,
        outputRoot: join(root, "report"),
        context: reportContext(42),
      }),
    /Unsafe artifact path/u,
  );
});

test("installs, indexes, prunes, and removes temporary PR reports", () => {
  const root = temporaryRoot();
  const artifacts = join(root, "artifacts");
  createEvidence(artifacts, "windows");
  createEvidence(artifacts, "linux");
  const site = join(root, "site");
  mkdirSync(site, { recursive: true });

  const report42 = join(root, "report-42");
  buildE2eReport({
    artifactsRoot: artifacts,
    outputRoot: report42,
    context: reportContext(42),
  });
  installE2eReport({ siteRoot: site, reportRoot: report42, prNumber: 42 });

  const report43 = join(root, "report-43");
  buildE2eReport({
    artifactsRoot: artifacts,
    outputRoot: report43,
    context: reportContext(43),
  });
  installE2eReport({ siteRoot: site, reportRoot: report43, prNumber: 43 });

  assert.match(readFileSync(join(site, "index.html"), "utf8"), /PR #42/u);
  assert.match(readFileSync(join(site, "index.html"), "utf8"), /PR #43/u);
  pruneE2eReports({ siteRoot: site, openPrNumbers: [42] });
  assert.ok(existsSync(join(site, "e2e", "pr", "42", "index.html")));
  assert.equal(existsSync(join(site, "e2e", "pr", "43")), false);

  removeE2eReport({ siteRoot: site, prNumber: 42 });
  assert.equal(existsSync(join(site, "e2e", "pr", "42")), false);
  assert.match(
    readFileSync(join(site, "index.html"), "utf8"),
    /No active pull request reports/u,
  );
});

function createEvidence(artifactsRoot, platform, options = {}) {
  const evidenceRoot = join(artifactsRoot, `desktop-e2e-${platform}-123-1`);
  const tracked = [];
  const add = (relativePath, contents) => {
    const path = join(evidenceRoot, ...relativePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    writeFileSync(path, buffer);
    tracked.push({
      path: relativePath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    });
  };

  const credentialClean = options.credentialClean ?? true;
  add(
    "credential-scan.json",
    `${JSON.stringify({ clean: credentialClean, findings: [] }, null, 2)}\n`,
  );
  add(
    "provider-cli-contract.json",
    `${JSON.stringify(
      {
        status: "passed",
        startedAt: "2026-08-17T00:00:00Z",
        completedAt: "2026-08-17T00:00:05Z",
        packages: [
          {
            provider: "claude",
            package: "@anthropic-ai/claude-code",
            pinnedVersion: "1.2.3",
            platformPackage: "@anthropic-ai/claude-code-test",
            platformPackageVersion: "1.2.3",
            observedVersion: "1.2.3",
            expectedSha256: "a".repeat(64),
            sha256: "a".repeat(64),
          },
        ],
        checks: [
          {
            id: "claude-version",
            provider: "claude",
            kind: "version",
            status: "passed",
            durationMs: 15,
            exitCode: 0,
            output: "sensitive raw output",
          },
          {
            id: "<script>alert(1)</script>",
            provider: "claude",
            kind: "integrity",
            status: "passed",
            durationMs: 1,
            exitCode: 0,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  add(
    "process-cleanup.json",
    `${JSON.stringify({ clean: true, gracefulCleanup: true }, null, 2)}\n`,
  );
  add("display-cleanup.json", `${JSON.stringify({ clean: true }, null, 2)}\n`);
  add(
    "log-diagnostics.json",
    `${JSON.stringify(
      {
        clean: true,
        knownWarnings: {
          windowsWdioNullableU32: platform === "windows" ? 2 : 0,
        },
        unexpectedErrors: [],
      },
      null,
      2,
    )}\n`,
  );
  add(
    "junit.xml",
    '<?xml version="1.0"?><testsuites tests="1" failures="0" errors="0" skipped="0" time="1.25"></testsuites>\n',
  );
  add("acceptance/claude-resume.gif", GIF);
  add("screenshots/claude-resume/001.png", PNG);
  add("screenshots/claude-resume/002.png", PNG);
  add(
    "screenshots/claude-resume/timeline.txt",
    "001 first <checkpoint>\n002 resumed response\n",
  );
  add("logs/backend.log", "private diagnostic log\n");

  writeJson(join(evidenceRoot, "manifest.json"), {
    runId: "123-1",
    runMode: "ci",
    commitSha: "a".repeat(40),
    platform,
    architecture: "x64",
    appVersion: "0.1.0-test",
    webviewVersion: "test-webview",
    workflowRunId: "123",
    finalStatus: "passed",
    workflowStatus: "success",
    stepOutcomes: {
      checkout: "success",
      dependencies: "success",
      backend: "success",
      build: "success",
      provider_contract: "success",
      desktop_e2e: "success",
    },
    credentialScan: { clean: credentialClean },
    processCleanup: { clean: true },
    cleanupStatus: { clean: true, graceful: true },
    displayCleanup: { clean: true },
    scenarios: [
      {
        scenarioId: "claude-resume",
        fullTitle: "creates a Space and resumes Claude",
        state: "passed",
        durationMs: 1250,
      },
    ],
    generatedAt: "2026-08-17T00:00:10Z",
    files: tracked,
  });
  return evidenceRoot;
}

function reportContext(prNumber) {
  return {
    repository: "bakapiano/ccsm2",
    prNumber,
    commitSha: "b".repeat(40),
    runId: 123,
    runAttempt: 1,
    conclusion: "success",
    runUrl: "https://github.com/bakapiano/ccsm2/actions/runs/123",
    prUrl: `https://github.com/bakapiano/ccsm2/pull/${prNumber}`,
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T00:00:10Z",
  };
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "ccsm-e2e-report-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
