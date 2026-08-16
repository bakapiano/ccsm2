#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const readText = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const cargoLock = readText("Cargo.lock");
const cargoToml = readText("Cargo.toml");
const taoFixRevision = "c704261c519c58cfdd0bc2d58ba24e06a0b71c92";
const cratesIoSource =
  "registry+https://github.com/rust-lang/crates.io-index";
const taoFixSource =
  `git+https://github.com/tauri-apps/tao?rev=${taoFixRevision}#${taoFixRevision}`;

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
  ["tao", { version: "0.35.3", source: taoFixSource }],
  ["wry", { version: "0.55.1", source: cratesIoSource }],
  [
    "tauri-runtime",
    { version: "2.11.3", source: cratesIoSource },
  ],
  [
    "tauri-runtime-wry",
    { version: "2.11.4", source: cratesIoSource },
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
  !new RegExp(
    `^tao = \\{ git = "https://github\\.com/tauri-apps/tao", rev = "${taoFixRevision}" \\}$`,
    "m",
  ).test(cargoToml)
) {
  throw new Error(
    `Cargo.toml must patch Tao to the reviewed fix revision ${taoFixRevision}`,
  );
}

console.log(
  "Verified Tauri 2.11.5 with the reviewed Tao deadlock backport and Wry 0.55.1.",
);
