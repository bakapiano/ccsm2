#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const readText = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const cargoLock = readText("Cargo.lock");
const cargoToml = readText("Cargo.toml");
const vendoredManifest = readText("crates/vendor/tauri-runtime-wry/Cargo.toml");
const vendoredPatchNotes = readText("crates/vendor/tauri-runtime-wry/PATCHES.md");
const integrationRevision =
  "7cc68e74ff6981f5c50a52a67d56c5eb2d227188";
const publishedRuntimeChecksum =
  "4e6fac707727b7a2f48e4ded90976324267371073edbb415ffb73bb0458d203f";
const cratesIoSource =
  "registry+https://github.com/rust-lang/crates.io-index";

const packageBlocks = new Map();
for (const match of cargoLock.matchAll(
  /\[\[package\]\]\r?\n([\s\S]*?)(?=\r?\n\[\[package\]\]|\s*$)/g,
)) {
  const block = match[1];
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  if (name) {
    packageBlocks.set(name, block);
  }
}

const packageBlock = (packageName) => {
  const block = packageBlocks.get(packageName);
  if (!block) {
    throw new Error(`Cargo.lock has no ${packageName} package`);
  }
  return block;
};

const field = (packageName, fieldName, required = true) => {
  const block = packageBlock(packageName);
  const value = block.match(new RegExp(`^${fieldName} = "([^"]+)"`, "m"))?.[1];
  if (!value && required) {
    throw new Error(`Cargo.lock ${packageName} has no ${fieldName}`);
  }
  return value ?? null;
};

const expectedPackages = new Map([
  ["tauri", { version: "2.11.5", source: cratesIoSource }],
  ["tao", { version: "0.36.0", source: cratesIoSource }],
  ["wry", { version: "0.56.1", source: cratesIoSource }],
  [
    "tauri-runtime",
    { version: "2.11.3", source: cratesIoSource },
  ],
  [
    "tauri-runtime-wry",
    { version: "2.11.4", source: null },
  ],
  ["tauri-utils", { version: "2.9.3", source: cratesIoSource }],
]);

for (const [packageName, expected] of expectedPackages) {
  const actualVersion = field(packageName, "version");
  const actualSource = field(packageName, "source", false);
  if (actualVersion !== expected.version || actualSource !== expected.source) {
    throw new Error(
      `${packageName} must resolve to ${expected.version} from ${expected.source}; ` +
        `found ${actualVersion} from ${actualSource}`,
    );
  }
}

if (
  !/^tauri-runtime-wry = \{ path = "crates\/vendor\/tauri-runtime-wry" \}$/m.test(
    cargoToml,
  )
) {
  throw new Error("Cargo.toml must patch tauri-runtime-wry to the vendored adapter");
}

for (const expectation of [
  ['version = "0.36.0"', "Tao 0.36.0"],
  ['version = "0.56.0"', "Wry 0.56"],
  ['rust-version = "1.90"', "Rust 1.90"],
]) {
  if (!vendoredManifest.includes(expectation[0])) {
    throw new Error(`Vendored runtime manifest must integrate ${expectation[1]}`);
  }
}
if (!vendoredPatchNotes.includes(integrationRevision)) {
  throw new Error(
    `Vendored runtime patch notes must cite Tauri integration revision ${integrationRevision}`,
  );
}
if (!vendoredPatchNotes.includes(publishedRuntimeChecksum)) {
  throw new Error(
    `Vendored runtime patch notes must cite the crates.io 2.11.4 checksum ${publishedRuntimeChecksum}`,
  );
}

console.log(
  "Verified Tauri 2.11.5 with the vendored runtime adapter, Tao 0.36.0, and Wry 0.56.1.",
);
