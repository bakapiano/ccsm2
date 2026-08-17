#!/usr/bin/env node

import { buildE2eReport } from "./e2e-report-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const report = buildE2eReport({
  artifactsRoot: requiredOption(options, "artifacts"),
  outputRoot: requiredOption(options, "output"),
  workflowJobsPath: options.get("workflow-jobs"),
  context: {
    repository: requiredEnvironment("CCSM_REPORT_REPOSITORY"),
    prNumber: requiredEnvironment("CCSM_REPORT_PR_NUMBER"),
    commitSha: requiredEnvironment("CCSM_REPORT_COMMIT_SHA"),
    runId: requiredEnvironment("CCSM_REPORT_RUN_ID"),
    runAttempt: requiredEnvironment("CCSM_REPORT_RUN_ATTEMPT"),
    conclusion: process.env.CCSM_REPORT_CONCLUSION ?? "unknown",
    runUrl: requiredEnvironment("CCSM_REPORT_RUN_URL"),
    prUrl: requiredEnvironment("CCSM_REPORT_PR_URL"),
    createdAt: process.env.CCSM_REPORT_CREATED_AT,
    updatedAt: process.env.CCSM_REPORT_UPDATED_AT,
  },
});

console.log(
  `Generated E2E report for PR #${report.context.prNumber} with ${report.platforms.length} platform entries.`,
);

function parseOptions(arguments_) {
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        `Expected --name value arguments; received ${name ?? "end of input"}`,
      );
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function requiredOption(options_, name) {
  const value = options_.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
