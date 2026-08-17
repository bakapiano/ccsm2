#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  installE2eReport,
  pruneE2eReports,
  removeE2eReport,
} from "./e2e-report-lib.mjs";

const [command, ...arguments_] = process.argv.slice(2);
const options = parseOptions(arguments_);
const siteRoot = requiredOption(options, "site");

if (command === "install") {
  const destination = installE2eReport({
    siteRoot,
    reportRoot: requiredOption(options, "report"),
    prNumber: requiredOption(options, "pr"),
  });
  console.log(`Installed E2E report at ${destination}`);
} else if (command === "remove") {
  removeE2eReport({
    siteRoot,
    prNumber: requiredOption(options, "pr"),
  });
  console.log(`Removed E2E report for PR #${requiredOption(options, "pr")}`);
} else if (command === "prune") {
  const openPrs = JSON.parse(
    readFileSync(requiredOption(options, "open-prs"), "utf8"),
  );
  if (!Array.isArray(openPrs))
    throw new Error("Open PR input must be an array");
  pruneE2eReports({
    siteRoot,
    openPrNumbers: openPrs.map((entry) =>
      typeof entry === "number" ? entry : entry?.number,
    ),
  });
  console.log(`Retained ${openPrs.length} active PR report(s).`);
} else {
  throw new Error(
    `Expected command install, remove, or prune; received ${command}`,
  );
}

function parseOptions(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
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
