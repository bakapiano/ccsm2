import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const REPORT_SCHEMA_VERSION = 1;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_JUNIT_BYTES = 2 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 32 * 1024;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 1000;
const MAX_DISCOVERY_ENTRIES = 2000;
const PLATFORM_ORDER = ["windows", "linux", "macos"];
const EXPECTED_PLATFORMS = ["windows", "linux"];
const SAFE_SCENARIO_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_PLATFORM = /^(?:windows|linux|macos)$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_COMMIT_SHA = /^[a-f0-9]{7,64}$/u;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const GIF_SIGNATURES = [Buffer.from("GIF87a"), Buffer.from("GIF89a")];

export function buildE2eReport({
  artifactsRoot,
  outputRoot,
  workflowJobsPath,
  context,
}) {
  const resolvedArtifactsRoot = existingDirectory(
    artifactsRoot,
    "artifacts root",
  );
  const resolvedOutputRoot = prepareEmptyDirectory(outputRoot, "report output");
  const normalizedContext = normalizeContext(context);
  const jobs = readWorkflowJobs(workflowJobsPath);
  const evidenceRoots = discoverEvidenceRoots(resolvedArtifactsRoot);
  const platforms = [];
  const seenPlatforms = new Set();

  for (const evidenceRoot of evidenceRoots) {
    const platform = readPlatformEvidence(evidenceRoot, resolvedOutputRoot);
    if (seenPlatforms.has(platform.platform)) {
      throw new Error(
        `Duplicate E2E evidence for platform: ${platform.platform}`,
      );
    }
    seenPlatforms.add(platform.platform);
    platforms.push(platform);
  }

  for (const expected of EXPECTED_PLATFORMS) {
    if (!seenPlatforms.has(expected)) {
      platforms.push(missingPlatform(expected));
    }
  }

  platforms.sort(
    (left, right) =>
      platformRank(left.platform) - platformRank(right.platform) ||
      left.platform.localeCompare(right.platform),
  );

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    context: normalizedContext,
    status: normalizeConclusion(normalizedContext.conclusion),
    jobs,
    platforms,
  };

  writeJson(join(resolvedOutputRoot, "report.json"), report);
  writeFileSync(join(resolvedOutputRoot, "index.html"), renderReport(report));
  return report;
}

export function installE2eReport({ siteRoot, reportRoot, prNumber }) {
  const resolvedSiteRoot = existingDirectory(siteRoot, "Pages site root");
  const resolvedReportRoot = existingDirectory(reportRoot, "report root");
  const normalizedPrNumber = positiveInteger(prNumber, "PR number");
  const report = readJson(
    join(resolvedReportRoot, "report.json"),
    MAX_JSON_BYTES,
  );
  validateGeneratedReport(report, normalizedPrNumber);

  const destination = safeChild(
    resolvedSiteRoot,
    join("e2e", "pr", String(normalizedPrNumber)),
  );
  removeContainedDirectory(resolvedSiteRoot, destination);
  mkdirSync(destination, { recursive: true });

  for (const source of walkRegularFiles(resolvedReportRoot)) {
    const relativePath = portableRelative(resolvedReportRoot, source);
    if (!isGeneratedReportFile(relativePath)) {
      throw new Error(`Unexpected generated report file: ${relativePath}`);
    }
    const target = safeChild(destination, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  renderPagesIndexes(resolvedSiteRoot);
  return destination;
}

export function removeE2eReport({ siteRoot, prNumber }) {
  const resolvedSiteRoot = existingDirectory(siteRoot, "Pages site root");
  const normalizedPrNumber = positiveInteger(prNumber, "PR number");
  const destination = safeChild(
    resolvedSiteRoot,
    join("e2e", "pr", String(normalizedPrNumber)),
  );
  removeContainedDirectory(resolvedSiteRoot, destination);
  renderPagesIndexes(resolvedSiteRoot);
}

export function pruneE2eReports({ siteRoot, openPrNumbers }) {
  const resolvedSiteRoot = existingDirectory(siteRoot, "Pages site root");
  const keep = new Set(
    openPrNumbers.map((value) => positiveInteger(value, "open PR number")),
  );
  const prRoot = safeChild(resolvedSiteRoot, join("e2e", "pr"));
  if (existsSync(prRoot)) {
    for (const entry of readdirSync(prRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const prNumber = Number(entry.name);
      if (!keep.has(prNumber)) {
        removeContainedDirectory(resolvedSiteRoot, join(prRoot, entry.name));
      }
    }
  }
  renderPagesIndexes(resolvedSiteRoot);
}

export function renderPagesIndexes(siteRoot) {
  const resolvedSiteRoot = resolve(siteRoot);
  mkdirSync(resolvedSiteRoot, { recursive: true });
  const reports = listInstalledReports(resolvedSiteRoot);
  writeFileSync(join(resolvedSiteRoot, ".nojekyll"), "");
  writeFileSync(
    join(resolvedSiteRoot, "index.html"),
    renderReportIndex(reports, "./e2e/pr/"),
  );
  const e2eRoot = safeChild(resolvedSiteRoot, "e2e");
  mkdirSync(e2eRoot, { recursive: true });
  writeFileSync(
    join(e2eRoot, "index.html"),
    renderReportIndex(reports, "./pr/"),
  );
  writeJson(
    join(e2eRoot, "reports.json"),
    reports.map((entry) => ({
      prNumber: entry.context.prNumber,
      status: entry.status,
      commitSha: entry.context.commitSha,
      runId: entry.context.runId,
      runAttempt: entry.context.runAttempt,
      generatedAt: entry.generatedAt,
      platforms: entry.platforms.map((platform) => ({
        platform: platform.platform,
        finalStatus: platform.finalStatus,
      })),
    })),
  );
}

function readPlatformEvidence(evidenceRoot, outputRoot) {
  const manifest = readJson(
    join(evidenceRoot, "manifest.json"),
    MAX_MANIFEST_BYTES,
  );
  const fileMap = validateManifest(manifest);
  const platform = requiredPattern(
    manifest.platform,
    SAFE_PLATFORM,
    "manifest platform",
  );
  const credentialScan = readVerifiedJson(
    evidenceRoot,
    fileMap,
    "credential-scan.json",
    { clean: false, findings: ["credential scan unavailable"] },
  );
  const mediaPublished =
    credentialScan.clean === true && manifest.credentialScan?.clean === true;
  const timelines = readTimelines(evidenceRoot, fileMap);
  const media = mediaPublished
    ? publishMedia({ evidenceRoot, outputRoot, fileMap, platform, timelines })
    : { gifs: [], screenshots: [] };
  const providerContract = readProviderContract(evidenceRoot, fileMap);
  const processCleanup = readVerifiedJson(
    evidenceRoot,
    fileMap,
    "process-cleanup.json",
    {},
  );
  const displayCleanup = readVerifiedJson(
    evidenceRoot,
    fileMap,
    "display-cleanup.json",
    {},
  );
  const logDiagnostics = readVerifiedJson(
    evidenceRoot,
    fileMap,
    "log-diagnostics.json",
    {},
  );

  return {
    platform,
    available: true,
    architecture: optionalText(manifest.architecture, 64),
    appVersion: optionalText(manifest.appVersion, 64),
    webviewVersion: optionalText(manifest.webviewVersion, 128),
    finalStatus: normalizeConclusion(manifest.finalStatus),
    workflowStatus: normalizeConclusion(manifest.workflowStatus),
    generatedAt: optionalIsoDate(manifest.generatedAt),
    mediaPublished,
    mediaWithheldReason: mediaPublished
      ? null
      : "Credential scan did not authorize public media.",
    health: {
      credentialScan: booleanStatus(credentialScan.clean),
      processCleanup: booleanStatus(
        manifest.processCleanup?.clean ?? processCleanup.clean,
      ),
      gracefulCleanup: booleanStatus(
        manifest.cleanupStatus?.graceful ?? processCleanup.gracefulCleanup,
      ),
      displayCleanup: booleanStatus(
        manifest.displayCleanup?.clean ?? displayCleanup.clean,
      ),
      logAudit: Array.isArray(logDiagnostics.unexpectedErrors)
        ? booleanStatus(logDiagnostics.unexpectedErrors.length === 0)
        : "unknown",
      knownWarnings: summarizeKnownWarnings(logDiagnostics.knownWarnings),
    },
    stepOutcomes: sanitizeStringRecord(manifest.stepOutcomes),
    scenarios: sanitizeScenarios(manifest.scenarios, media, timelines),
    junit: readJunitSummary(evidenceRoot, fileMap),
    providerContract,
    media,
  };
}

function readProviderContract(evidenceRoot, fileMap) {
  const contract = readVerifiedJson(
    evidenceRoot,
    fileMap,
    "provider-cli-contract.json",
    {},
  );
  const packages = Array.isArray(contract.packages)
    ? contract.packages.slice(0, 20).map((entry) => ({
        provider: optionalText(entry?.provider, 64),
        package: optionalText(entry?.package, 128),
        pinnedVersion: optionalText(entry?.pinnedVersion, 64),
        platformPackage: optionalText(entry?.platformPackage, 128),
        platformPackageVersion: optionalText(entry?.platformPackageVersion, 64),
        observedVersion: optionalText(entry?.observedVersion, 128),
        integrity:
          typeof entry?.expectedSha256 === "string" &&
          typeof entry?.sha256 === "string" &&
          entry.expectedSha256 === entry.sha256
            ? "passed"
            : "failed",
      }))
    : [];
  const checks = Array.isArray(contract.checks)
    ? contract.checks.slice(0, 200).map((entry) => ({
        id: optionalText(entry?.id, 128),
        provider: optionalText(entry?.provider, 64),
        kind: optionalText(entry?.kind, 64),
        status: normalizeConclusion(entry?.status),
        durationMs: nonNegativeNumber(entry?.durationMs),
        exitCode: finiteInteger(entry?.exitCode),
      }))
    : [];
  return {
    status: normalizeConclusion(contract.status),
    startedAt: optionalIsoDate(contract.startedAt),
    completedAt: optionalIsoDate(contract.completedAt),
    packages,
    checks,
  };
}

function publishMedia({
  evidenceRoot,
  outputRoot,
  fileMap,
  platform,
  timelines,
}) {
  const gifs = [];
  const screenshots = [];
  for (const [path] of fileMap) {
    const gifMatch = path.match(/^acceptance\/([^/]+)\.gif$/u);
    if (gifMatch && SAFE_SCENARIO_ID.test(gifMatch[1])) {
      verifyManifestFile(evidenceRoot, fileMap, path, MAX_GIF_BYTES);
      verifyGif(join(evidenceRoot, ...path.split("/")));
      const publicPath = `assets/${platform}/${path}`;
      copyVerifiedAsset(evidenceRoot, outputRoot, path, publicPath);
      gifs.push({ scenarioId: gifMatch[1], path: publicPath });
      continue;
    }

    const screenshotMatch = path.match(/^screenshots\/([^/]+)\/(\d{3})\.png$/u);
    if (screenshotMatch && SAFE_SCENARIO_ID.test(screenshotMatch[1])) {
      verifyManifestFile(evidenceRoot, fileMap, path, MAX_PNG_BYTES);
      verifyPng(join(evidenceRoot, ...path.split("/")));
      const publicPath = `assets/${platform}/${path}`;
      copyVerifiedAsset(evidenceRoot, outputRoot, path, publicPath);
      const frame = Number(screenshotMatch[2]);
      screenshots.push({
        scenarioId: screenshotMatch[1],
        frame,
        label:
          timelines.get(screenshotMatch[1])?.get(frame) ??
          `Checkpoint ${screenshotMatch[2]}`,
        path: publicPath,
      });
    }
  }
  gifs.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  screenshots.sort(
    (left, right) =>
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.frame - right.frame,
  );
  return { gifs, screenshots };
}

function readTimelines(evidenceRoot, fileMap) {
  const timelines = new Map();
  for (const [path] of fileMap) {
    const match = path.match(/^screenshots\/([^/]+)\/timeline\.txt$/u);
    if (!match || !SAFE_SCENARIO_ID.test(match[1])) continue;
    const source = verifyManifestFile(
      evidenceRoot,
      fileMap,
      path,
      MAX_TIMELINE_BYTES,
    );
    const frames = new Map();
    for (const rawLine of readFileSync(source, "utf8").split(/\r?\n/u)) {
      if (!rawLine) continue;
      const line = rawLine.match(/^(\d{3}) ([\x20-\x7e]{1,160})$/u);
      if (!line) throw new Error(`Invalid timeline entry in ${path}`);
      frames.set(Number(line[1]), line[2]);
    }
    timelines.set(match[1], frames);
  }
  return timelines;
}

function sanitizeScenarios(value, media, timelines) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => {
    const scenarioId = requiredPattern(
      entry?.scenarioId,
      SAFE_SCENARIO_ID,
      "scenario ID",
    );
    return {
      scenarioId,
      fullTitle: optionalText(entry?.fullTitle, 240) ?? scenarioId,
      state: normalizeConclusion(entry?.state),
      durationMs: nonNegativeNumber(entry?.durationMs),
      failureStep: optionalText(entry?.failureStep, 128),
      gif:
        media.gifs.find((item) => item.scenarioId === scenarioId)?.path ?? null,
      screenshots: media.screenshots.filter(
        (item) => item.scenarioId === scenarioId,
      ),
      checkpointCount: timelines.get(scenarioId)?.size ?? 0,
    };
  });
}

function readJunitSummary(evidenceRoot, fileMap) {
  if (!fileMap.has("junit.xml")) return null;
  const path = verifyManifestFile(
    evidenceRoot,
    fileMap,
    "junit.xml",
    MAX_JUNIT_BYTES,
  );
  const contents = readFileSync(path, "utf8");
  const root = contents.match(/<(?:testsuites|testsuite)\b([^>]*)>/u)?.[1];
  if (!root) return null;
  const attribute = (name) => {
    const value = root.match(new RegExp(`\\b${name}="([^"]+)"`, "u"))?.[1];
    return value === undefined ? null : Number(value);
  };
  return {
    tests: finiteInteger(attribute("tests")),
    failures: finiteInteger(attribute("failures")),
    errors: finiteInteger(attribute("errors")),
    skipped: finiteInteger(attribute("skipped")),
    timeSeconds: nonNegativeNumber(attribute("time")),
  };
}

function readWorkflowJobs(path) {
  if (!path || !existsSync(path)) return [];
  const payload = readJson(path, MAX_JSON_BYTES);
  if (!Array.isArray(payload.jobs)) return [];
  return payload.jobs.slice(0, 100).map((job) => ({
    name: optionalText(job?.name, 160) ?? "unnamed job",
    status: normalizeConclusion(job?.status),
    conclusion: normalizeConclusion(job?.conclusion),
    startedAt: optionalIsoDate(job?.started_at),
    completedAt: optionalIsoDate(job?.completed_at),
    durationMs: durationBetween(job?.started_at, job?.completed_at),
    url: optionalHttpsUrl(job?.html_url),
    steps: Array.isArray(job?.steps)
      ? job.steps.slice(0, 100).map((step) => ({
          name: optionalText(step?.name, 160) ?? "unnamed step",
          status: normalizeConclusion(step?.status),
          conclusion: normalizeConclusion(step?.conclusion),
          durationMs: durationBetween(step?.started_at, step?.completed_at),
        }))
      : [],
  }));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("E2E manifest must be an object");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("E2E manifest files must be an array");
  }
  if (manifest.files.length > MAX_ARTIFACT_FILES) {
    throw new Error("E2E manifest contains too many files");
  }
  const fileMap = new Map();
  for (const entry of manifest.files) {
    const path = validateRelativeArtifactPath(entry?.path);
    const bytes = finiteInteger(entry?.bytes);
    const sha256 = requiredPattern(entry?.sha256, SAFE_SHA256, "file SHA-256");
    if (bytes === null || bytes < 0) {
      throw new Error(`Invalid byte count for ${path}`);
    }
    if (fileMap.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
    fileMap.set(path, { bytes, sha256 });
  }
  return fileMap;
}

function readVerifiedJson(evidenceRoot, fileMap, path, fallback) {
  if (!fileMap.has(path)) return fallback;
  const source = verifyManifestFile(
    evidenceRoot,
    fileMap,
    path,
    MAX_JSON_BYTES,
  );
  return readJson(source, MAX_JSON_BYTES);
}

function verifyManifestFile(evidenceRoot, fileMap, path, maximumBytes) {
  const entry = fileMap.get(path);
  if (!entry) throw new Error(`Manifest entry is missing: ${path}`);
  if (entry.bytes > maximumBytes) {
    throw new Error(`Artifact file exceeds public report limit: ${path}`);
  }
  const source = safeArtifactFile(evidenceRoot, path);
  const stats = lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Artifact path is not a regular file: ${path}`);
  }
  if (stats.size !== entry.bytes) {
    throw new Error(`Artifact size mismatch: ${path}`);
  }
  const digest = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`Artifact SHA-256 mismatch: ${path}`);
  }
  return source;
}

function copyVerifiedAsset(evidenceRoot, outputRoot, path, publicPath) {
  const source = safeArtifactFile(evidenceRoot, path);
  const destination = safeChild(outputRoot, publicPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function discoverEvidenceRoots(root) {
  const roots = [];
  let visited = 0;
  const visit = (directory, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_DISCOVERY_ENTRIES) {
        throw new Error("Artifact discovery entry limit exceeded");
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Artifact tree contains a symbolic link: ${path}`);
      }
      if (entry.isFile() && entry.name === "manifest.json") {
        roots.push(directory);
      } else if (entry.isDirectory()) {
        visit(path, depth + 1);
      }
    }
  };
  visit(root, 0);
  roots.sort();
  return [...new Set(roots)];
}

function renderReport(report) {
  const context = report.context;
  const platformSections = report.platforms.map(renderPlatform).join("\n");
  const jobs = report.jobs.map(renderJob).join("\n");
  const passedJobs = report.jobs.filter(
    (job) => job.conclusion === "passed",
  ).length;
  const totalScenarios = report.platforms.reduce(
    (sum, platform) => sum + platform.scenarios.length,
    0,
  );
  const passedScenarios = report.platforms.reduce(
    (sum, platform) =>
      sum +
      platform.scenarios.filter((scenario) => scenario.state === "passed")
        .length,
    0,
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>CCSM E2E · PR #${context.prNumber}</title>
  <style>${reportStyles()}</style>
</head>
<body>
  <header class="hero">
    <div>
      <p class="eyebrow">CCSM Desktop E2E evidence</p>
      <h1>PR #${context.prNumber}</h1>
      <p class="lede">Windows and Linux · real provider CLIs · loopback model API</p>
    </div>
    ${statusBadge(report.status)}
  </header>
  <main>
    <section class="summary-grid" aria-label="Run summary">
      ${summaryCard("Workflow jobs", `${passedJobs}/${report.jobs.length}`, "passed")}
      ${summaryCard("Desktop scenarios", `${passedScenarios}/${totalScenarios}`, passedScenarios === totalScenarios && totalScenarios > 0 ? "passed" : "failed")}
      ${summaryCard("Commit", escapeHtml(context.commitSha.slice(0, 12)), "neutral")}
      ${summaryCard("Run attempt", `${context.runId} · ${context.runAttempt}`, "neutral")}
    </section>
    <nav class="links" aria-label="Run links">
      <a href="${escapeAttribute(context.prUrl)}">Pull request</a>
      <a href="${escapeAttribute(context.runUrl)}">GitHub Actions run</a>
      <span>Generated ${escapeHtml(formatDate(report.generatedAt))}</span>
    </nav>
    <section>
      <div class="section-heading">
        <div><p class="eyebrow">GitHub Actions</p><h2>All workflow jobs</h2></div>
        <p>${report.jobs.length} jobs from the triggering CI run</p>
      </div>
      <div class="job-list">${jobs || emptyState("Workflow job metadata is unavailable.")}</div>
    </section>
    ${platformSections}
  </main>
  <footer>Generated from validated E2E evidence. Public media passed the credential scan and manifest integrity checks.</footer>
</body>
</html>`;
}

function renderPlatform(platform) {
  if (!platform.available) {
    return `<section class="platform" id="${escapeAttribute(platform.platform)}">
      <div class="section-heading"><div><p class="eyebrow">Platform</p><h2>${escapeHtml(platformLabel(platform.platform))}</h2></div>${statusBadge("missing")}</div>
      ${emptyState("This CI run did not provide a validated manifest for this platform. See the workflow job above for the failure stage.")}
    </section>`;
  }
  const scenarios = platform.scenarios.map(renderScenario).join("\n");
  const steps = Object.entries(platform.stepOutcomes)
    .map(
      ([name, status]) =>
        `<tr><td>${escapeHtml(humanize(name))}</td><td>${statusBadge(normalizeConclusion(status))}</td></tr>`,
    )
    .join("");
  const packages = platform.providerContract.packages
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.provider ?? "—")}</td>
        <td><code>${escapeHtml(entry.package ?? "—")}</code></td>
        <td>${escapeHtml(entry.pinnedVersion ?? "—")}</td>
        <td>${escapeHtml(entry.observedVersion ?? "—")}</td>
        <td>${statusBadge(entry.integrity)}</td>
      </tr>`,
    )
    .join("");
  const checks = platform.providerContract.checks
    .map(
      (entry) => `<tr>
        <td><code>${escapeHtml(entry.id ?? "—")}</code></td>
        <td>${escapeHtml(entry.provider ?? "shared")}</td>
        <td>${escapeHtml(entry.kind ?? "—")}</td>
        <td>${formatDuration(entry.durationMs)}</td>
        <td>${statusBadge(entry.status)}</td>
      </tr>`,
    )
    .join("");
  return `<section class="platform" id="${escapeAttribute(platform.platform)}">
    <div class="section-heading">
      <div><p class="eyebrow">Platform evidence</p><h2>${escapeHtml(platformLabel(platform.platform))}</h2></div>
      ${statusBadge(platform.finalStatus)}
    </div>
    <div class="meta-row">
      <span>${escapeHtml(platform.architecture ?? "unknown architecture")}</span>
      <span>App ${escapeHtml(platform.appVersion ?? "unknown")}</span>
      <span>${escapeHtml(platform.webviewVersion ?? "unknown WebView")}</span>
      <span>${escapeHtml(formatDate(platform.generatedAt))}</span>
    </div>
    <div class="two-column">
      <article class="panel"><h3>Workflow steps</h3><table><tbody>${steps}</tbody></table></article>
      <article class="panel"><h3>Evidence health</h3>${renderHealth(platform)}</article>
    </div>
    <div class="scenario-list">${scenarios || emptyState("No desktop scenarios were recorded.")}</div>
    <details class="panel contract" open>
      <summary><span>Provider CLI contract</span>${statusBadge(platform.providerContract.status)}</summary>
      <h3>Provider packages</h3>
      <div class="table-scroll"><table><thead><tr><th>Provider</th><th>Package</th><th>Pinned</th><th>Observed</th><th>SHA-256</th></tr></thead><tbody>${packages || `<tr><td colspan="5">No package results.</td></tr>`}</tbody></table></div>
      <h3>${platform.providerContract.checks.length} contract checks</h3>
      <div class="table-scroll"><table><thead><tr><th>Check</th><th>Provider</th><th>Kind</th><th>Duration</th><th>Result</th></tr></thead><tbody>${checks || `<tr><td colspan="5">No contract results.</td></tr>`}</tbody></table></div>
    </details>
  </section>`;
}

function renderScenario(scenario) {
  const screenshots = scenario.screenshots
    .map(
      (screenshot) => `<figure>
        <a href="${escapeAttribute(screenshot.path)}" target="_blank" rel="noopener"><img src="${escapeAttribute(screenshot.path)}" loading="lazy" alt="${escapeAttribute(`${scenario.fullTitle}: ${screenshot.label}`)}"></a>
        <figcaption><span>${String(screenshot.frame).padStart(3, "0")}</span>${escapeHtml(screenshot.label)}</figcaption>
      </figure>`,
    )
    .join("");
  const gif = scenario.gif
    ? `<a class="gif" href="${escapeAttribute(scenario.gif)}" target="_blank" rel="noopener"><img src="${escapeAttribute(scenario.gif)}" loading="lazy" alt="Animated acceptance evidence for ${escapeAttribute(scenario.fullTitle)}"></a>`
    : emptyState("Animated evidence was withheld or unavailable.");
  return `<details class="scenario" open>
    <summary>
      <span><strong>${escapeHtml(providerLabel(scenario.scenarioId))}</strong><small>${escapeHtml(scenario.fullTitle)}</small></span>
      <span class="scenario-result">${formatDuration(scenario.durationMs)} ${statusBadge(scenario.state)}</span>
    </summary>
    ${scenario.failureStep ? `<p class="failure">Failure step: ${escapeHtml(scenario.failureStep)}</p>` : ""}
    <div class="scenario-media">
      <div><h3>Acceptance animation</h3>${gif}</div>
      <div><h3>${scenario.screenshots.length} checkpoints</h3><div class="gallery">${screenshots || emptyState("Checkpoint media was withheld or unavailable.")}</div></div>
    </div>
  </details>`;
}

function renderHealth(platform) {
  const rows = [
    ["Credential scan", platform.health.credentialScan],
    ["Process cleanup", platform.health.processCleanup],
    ["Graceful cleanup", platform.health.gracefulCleanup],
    ["Display cleanup", platform.health.displayCleanup],
    ["Log audit", platform.health.logAudit],
  ];
  const warnings = Object.entries(platform.health.knownWarnings)
    .map(
      ([name, count]) =>
        `<li><span>${escapeHtml(humanize(name))}</span><strong>${count}</strong></li>`,
    )
    .join("");
  return `<ul class="health-list">${rows
    .map(
      ([name, status]) =>
        `<li><span>${escapeHtml(name)}</span>${statusBadge(status)}</li>`,
    )
    .join("")}</ul>
    ${warnings ? `<h4>Classified warnings</h4><ul class="health-list">${warnings}</ul>` : ""}
    ${platform.junit ? `<p class="muted">JUnit: ${platform.junit.tests ?? "—"} tests · ${platform.junit.failures ?? "—"} failures · ${platform.junit.errors ?? "—"} errors</p>` : ""}
    ${platform.mediaPublished ? "" : `<p class="notice">${escapeHtml(platform.mediaWithheldReason)}</p>`}`;
}

function renderJob(job) {
  const steps = job.steps
    .map(
      (step) =>
        `<tr><td>${escapeHtml(step.name)}</td><td>${formatDuration(step.durationMs)}</td><td>${statusBadge(step.conclusion)}</td></tr>`,
    )
    .join("");
  const heading = job.url
    ? `<a href="${escapeAttribute(job.url)}">${escapeHtml(job.name)}</a>`
    : escapeHtml(job.name);
  return `<details class="job">
    <summary><span>${heading}<small>${formatDuration(job.durationMs)}</small></span>${statusBadge(job.conclusion)}</summary>
    <table><tbody>${steps || `<tr><td>No step metadata.</td></tr>`}</tbody></table>
  </details>`;
}

function renderReportIndex(reports, pathPrefix) {
  const cards = reports
    .map((report) => {
      const context = report.context;
      const platforms = report.platforms
        .map(
          (platform) =>
            `<span>${escapeHtml(platformLabel(platform.platform))} ${statusBadge(platform.finalStatus)}</span>`,
        )
        .join("");
      return `<article class="report-card">
        <div><p class="eyebrow">Pull request</p><h2><a href="${escapeAttribute(`${pathPrefix}${context.prNumber}/`)}">PR #${context.prNumber}</a></h2></div>
        ${statusBadge(report.status)}
        <p><code>${escapeHtml(context.commitSha.slice(0, 12))}</code> · run ${context.runId}.${context.runAttempt}</p>
        <div class="platform-pills">${platforms}</div>
        <small>Updated ${escapeHtml(formatDate(report.generatedAt))}</small>
      </article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>CCSM E2E reports</title>
  <style>${reportStyles()}</style>
</head>
<body>
  <header class="hero"><div><p class="eyebrow">CCSM quality evidence</p><h1>Desktop E2E reports</h1><p class="lede">Temporary reports for active pull requests</p></div></header>
  <main><section class="report-grid">${cards || emptyState("No active pull request reports are published.")}</section></main>
  <footer>Reports contain validated PNG/GIF evidence and sanitized test summaries.</footer>
</body>
</html>`;
}

function reportStyles() {
  return `
    :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --panel-2:#191f2c; --line:#293146; --text:#f1f5ff; --muted:#9ba7bd; --accent:#79a7ff; --pass:#43d17d; --fail:#ff6b78; --warn:#f3c969; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at top left,#17213a 0,var(--bg) 34rem); color:var(--text); min-height:100vh; }
    a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
    code { font:0.9em ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
    .hero { max-width:1240px; margin:auto; padding:64px 28px 34px; display:flex; align-items:end; justify-content:space-between; gap:24px; }
    h1 { font-size:clamp(2.5rem,7vw,5.5rem); letter-spacing:-0.055em; line-height:.92; margin:.18em 0; } h2 { margin:.15em 0; font-size:clamp(1.6rem,3vw,2.5rem); } h3 { margin:0 0 14px; } h4 { margin:20px 0 8px; }
    .eyebrow { color:var(--accent); text-transform:uppercase; letter-spacing:.16em; font-size:.72rem; font-weight:800; margin:0; }
    .lede,.muted,.section-heading>p,small { color:var(--muted); }
    main { max-width:1240px; margin:auto; padding:0 28px 72px; }
    section { margin:36px 0; }
    .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
    .summary-card,.panel,.job,.scenario,.report-card { background:linear-gradient(145deg,var(--panel),#10141d); border:1px solid var(--line); border-radius:16px; box-shadow:0 18px 50px #0004; }
    .summary-card { padding:18px; } .summary-card strong { display:block; font-size:1.45rem; margin-top:8px; }
    .links,.meta-row,.platform-pills { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; color:var(--muted); }
    .links { padding:18px 0; border-bottom:1px solid var(--line); }
    .section-heading { display:flex; align-items:end; justify-content:space-between; gap:20px; margin:48px 0 18px; }
    .job-list,.scenario-list { display:grid; gap:10px; }
    details>summary { cursor:pointer; list-style:none; } details>summary::-webkit-details-marker { display:none; }
    .job>summary,.scenario>summary,.contract>summary { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:16px 18px; }
    .job>summary>span:first-child,.scenario>summary>span:first-child { display:grid; gap:5px; }
    .job table,.scenario table { border-top:1px solid var(--line); }
    .badge { display:inline-flex; align-items:center; border-radius:999px; padding:4px 9px; font-size:.72rem; font-weight:800; text-transform:uppercase; letter-spacing:.06em; white-space:nowrap; background:#30384b; color:#d8dfed; }
    .badge.passed { background:#143923; color:#75eba3; } .badge.failed,.badge.cancelled { background:#481d27; color:#ff9ba5; } .badge.missing,.badge.unknown,.badge.skipped { background:#3b3218; color:#f5d77b; }
    .two-column,.scenario-media { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.6fr); gap:14px; margin:16px 0; }
    .panel { padding:20px; } .contract { margin-top:16px; } .contract>summary { margin:-20px; margin-bottom:18px; border-bottom:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-size:.74rem; text-transform:uppercase; letter-spacing:.07em; }
    .table-scroll { overflow:auto; }
    .health-list { list-style:none; padding:0; margin:0; display:grid; gap:9px; } .health-list li { display:flex; justify-content:space-between; gap:16px; }
    .scenario { overflow:hidden; } .scenario-result { display:flex; align-items:center; gap:12px; color:var(--muted); }
    .scenario-media { padding:0 18px 20px; align-items:start; }
    .gif { display:block; border-radius:12px; overflow:hidden; border:1px solid var(--line); background:#080a0f; } .gif img { display:block; width:100%; height:auto; }
    .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
    figure { margin:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:#090c12; } figure img { display:block; width:100%; aspect-ratio:16/10; object-fit:cover; object-position:top; } figcaption { display:flex; gap:9px; padding:9px 10px; color:var(--muted); font-size:.78rem; } figcaption span { color:var(--accent); font-family:ui-monospace,monospace; }
    .empty,.notice,.failure { border:1px dashed var(--line); border-radius:12px; padding:18px; color:var(--muted); } .notice { border-color:#765f28; color:#f3d98f; } .failure { margin:0 18px 16px; border-color:#71303a; color:#ffabb3; }
    .report-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; } .report-card { padding:20px; display:grid; gap:14px; } .report-card>div:first-child { display:flex; align-items:start; justify-content:space-between; }
    footer { max-width:1240px; margin:auto; padding:24px 28px 48px; border-top:1px solid var(--line); color:var(--muted); font-size:.86rem; }
    @media (max-width:760px) { .hero,.section-heading { align-items:start; flex-direction:column; } .two-column,.scenario-media { grid-template-columns:1fr; } .scenario>summary { align-items:start; flex-direction:column; } }
  `;
}

function listInstalledReports(siteRoot) {
  const prRoot = safeChild(siteRoot, join("e2e", "pr"));
  if (!existsSync(prRoot)) return [];
  const reports = [];
  for (const entry of readdirSync(prRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const reportPath = join(prRoot, entry.name, "report.json");
    if (!existsSync(reportPath)) continue;
    const report = readJson(reportPath, MAX_JSON_BYTES);
    validateGeneratedReport(report, Number(entry.name));
    reports.push(report);
  }
  reports.sort(
    (left, right) =>
      Date.parse(right.generatedAt) - Date.parse(left.generatedAt) ||
      right.context.prNumber - left.context.prNumber,
  );
  return reports;
}

function validateGeneratedReport(report, expectedPrNumber) {
  if (
    !report ||
    report.schemaVersion !== REPORT_SCHEMA_VERSION ||
    !report.context ||
    report.context.prNumber !== expectedPrNumber ||
    !Array.isArray(report.platforms)
  ) {
    throw new Error("Generated report schema validation failed");
  }
  normalizeContext(report.context);
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Generated report contains a symbolic link: ${path}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Generated report contains a special file: ${path}`);
    }
  };
  visit(root);
  return files;
}

function isGeneratedReportFile(path) {
  return (
    path === "index.html" ||
    path === "report.json" ||
    /^assets\/(?:windows|linux|macos)\/(?:acceptance\/[a-z0-9-]+\.gif|screenshots\/[a-z0-9-]+\/\d{3}\.png)$/u.test(
      path,
    )
  );
}

function missingPlatform(platform) {
  return {
    platform,
    available: false,
    architecture: null,
    appVersion: null,
    webviewVersion: null,
    finalStatus: "missing",
    workflowStatus: "missing",
    generatedAt: null,
    mediaPublished: false,
    mediaWithheldReason: "Validated evidence manifest is unavailable.",
    health: {
      credentialScan: "unknown",
      processCleanup: "unknown",
      gracefulCleanup: "unknown",
      displayCleanup: "unknown",
      logAudit: "unknown",
      knownWarnings: {},
    },
    stepOutcomes: {},
    scenarios: [],
    junit: null,
    providerContract: { status: "missing", packages: [], checks: [] },
    media: { gifs: [], screenshots: [] },
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") {
    throw new Error("Report context is required");
  }
  return {
    repository: requiredPattern(
      context.repository,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
      "repository",
    ),
    prNumber: positiveInteger(context.prNumber, "PR number"),
    commitSha: requiredPattern(
      context.commitSha,
      SAFE_COMMIT_SHA,
      "commit SHA",
    ),
    runId: positiveInteger(context.runId, "workflow run ID"),
    runAttempt: positiveInteger(context.runAttempt, "workflow run attempt"),
    conclusion: normalizeConclusion(context.conclusion),
    runUrl: requiredHttpsUrl(context.runUrl, "workflow run URL"),
    prUrl: requiredHttpsUrl(context.prUrl, "pull request URL"),
    createdAt: optionalIsoDate(context.createdAt),
    updatedAt: optionalIsoDate(context.updatedAt),
  };
}

function normalizeConclusion(value) {
  const normalized =
    typeof value === "string" ? value.toLowerCase() : "unknown";
  if (normalized === "success") return "passed";
  if (normalized === "failure" || normalized === "timed_out") return "failed";
  if (
    [
      "passed",
      "failed",
      "cancelled",
      "skipped",
      "neutral",
      "action_required",
      "stale",
      "missing",
      "unknown",
      "queued",
      "in_progress",
      "completed",
      "not-run",
      "unavailable",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "unknown";
}

function sanitizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [optionalText(key, 128), optionalText(entry, 64)])
      .filter(([key, entry]) => key && entry),
  );
}

function summarizeKnownWarnings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => Number.isInteger(entry) && entry >= 0)
      .slice(0, 20)
      .map(([key, entry]) => [optionalText(key, 128), entry])
      .filter(([key]) => key),
  );
}

function validateRelativeArtifactPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 300 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  ) {
    throw new Error("Invalid artifact path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 120,
    )
  ) {
    throw new Error(`Unsafe artifact path: ${value}`);
  }
  return value;
}

function safeArtifactFile(root, relativePath) {
  const validated = validateRelativeArtifactPath(relativePath);
  return safeChild(root, join(...validated.split("/")));
}

function safeChild(root, child) {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  if (
    resolvedChild !== resolvedRoot &&
    !resolvedChild.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error(`Path escapes intended root: ${child}`);
  }
  return resolvedChild;
}

function removeContainedDirectory(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget === resolvedRoot ||
    !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error(`Refusing to remove path outside intended root: ${target}`);
  }
  if (existsSync(resolvedTarget)) {
    rmSync(resolvedTarget, { recursive: true, force: true });
  }
}

function prepareEmptyDirectory(path, label) {
  if (!path) throw new Error(`${label} is required`);
  const resolved = resolve(path);
  const parsedRoot = resolve(resolved, sep);
  if (resolved === parsedRoot || resolved === resolve(".")) {
    throw new Error(`Unsafe ${label}: ${resolved}`);
  }
  if (existsSync(resolved)) {
    rmSync(resolved, { recursive: true, force: true });
  }
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function existingDirectory(path, label) {
  if (!path) throw new Error(`${label} is required`);
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

function readJson(path, maximumBytes) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`JSON input is not a regular file: ${path}`);
  }
  if (stats.size > maximumBytes) {
    throw new Error(`JSON input exceeds size limit: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON input: ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function verifyPng(path) {
  const signature = readFileSync(path).subarray(0, PNG_SIGNATURE.length);
  if (!signature.equals(PNG_SIGNATURE)) {
    throw new Error(`Invalid PNG signature: ${path}`);
  }
}

function verifyGif(path) {
  const signature = readFileSync(path).subarray(0, 6);
  if (!GIF_SIGNATURES.some((candidate) => signature.equals(candidate))) {
    throw new Error(`Invalid GIF signature: ${path}`);
  }
}

function requiredPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredHttpsUrl(value, label) {
  const normalized = optionalHttpsUrl(value);
  if (!normalized) throw new Error(`Invalid ${label}`);
  return normalized;
}

function optionalHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function optionalText(value, maximumLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    "�",
  );
  return normalized.slice(0, maximumLength);
}

function optionalIsoDate(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}

function positiveInteger(value, label) {
  const number =
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function finiteInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function durationBetween(startedAt, completedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;
}

function booleanStatus(value) {
  if (value === true) return "passed";
  if (value === false) return "failed";
  return "unknown";
}

function platformRank(platform) {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index === -1 ? PLATFORM_ORDER.length : index;
}

function platformLabel(platform) {
  return (
    { windows: "Windows", linux: "Linux", macos: "macOS" }[platform] ?? platform
  );
}

function providerLabel(scenarioId) {
  if (scenarioId.startsWith("claude")) return "Claude Code";
  if (scenarioId.startsWith("codex")) return "OpenAI Codex";
  if (scenarioId.startsWith("ghcp") || scenarioId.startsWith("copilot")) {
    return "GitHub Copilot CLI";
  }
  return humanize(scenarioId);
}

function humanize(value) {
  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "unknown time";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}

function statusBadge(status) {
  const normalized = normalizeConclusion(status);
  return `<span class="badge ${escapeAttribute(normalized)}">${escapeHtml(normalized)}</span>`;
}

function summaryCard(label, value, status) {
  return `<article class="summary-card"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${statusBadge(status)}</article>`;
}

function emptyState(message) {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}
