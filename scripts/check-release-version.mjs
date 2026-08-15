#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const readText = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const extract = (value, pattern, label) => {
  const match = value.match(pattern);
  if (!match) {
    throw new Error(`Could not read ${label}`);
  }
  return match[1];
};

const cargoToml = readText("Cargo.toml");
const cargoLock = readText("Cargo.lock");
const packageVersion = readJson("package.json").version;
const versions = new Map([
  ["package.json", packageVersion],
  ["apps/desktop/package.json", readJson("apps/desktop/package.json").version],
  [
    "apps/desktop/src-tauri/tauri.conf.json",
    readJson("apps/desktop/src-tauri/tauri.conf.json").version,
  ],
  [
    "Cargo.toml workspace",
    extract(
      cargoToml,
      /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
      "Cargo workspace version",
    ),
  ],
]);

for (const crate of ["ccsm-core", "ccsm-desktop", "ccsm-platform"]) {
  versions.set(
    `Cargo.lock ${crate}`,
    extract(
      cargoLock,
      new RegExp(
        `\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = "([^"]+)"`,
      ),
      `Cargo.lock version for ${crate}`,
    ),
  );
}

const requestedVersion = process.argv[2] ?? process.env.RELEASE_VERSION;
const expectedVersion = requestedVersion?.replace(/^v/, "") ?? packageVersion;
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!semver.test(expectedVersion)) {
  throw new Error(`Invalid release version: ${expectedVersion}`);
}

const mismatches = [...versions].filter(
  ([, version]) => version !== expectedVersion,
);
if (mismatches.length > 0) {
  console.error(`Release version mismatch; expected ${expectedVersion}:`);
  for (const [source, version] of versions) {
    console.error(`  ${source}: ${version}`);
  }
  process.exit(1);
}

console.log(
  `Release version ${expectedVersion} is consistent across manifests and Cargo.lock.`,
);
