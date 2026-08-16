#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const readText = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const cargoToml = readText("Cargo.toml");
const taoFixRevision = "c704261c519c58cfdd0bc2d58ba24e06a0b71c92";
const cratesIoSource =
  "registry+https://github.com/rust-lang/crates.io-index";
const taoFixSource =
  `git+https://github.com/tauri-apps/tao?rev=${taoFixRevision}#${taoFixRevision}`;

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const resolveNodes = new Map(
  metadata.resolve.nodes.map((node) => [node.id, node]),
);

const resolvedPackage = (name, version, source) => {
  const matches = metadata.packages.filter(
    (candidate) =>
      candidate.name === name &&
      candidate.version === version &&
      candidate.source === source,
  );
  if (matches.length !== 1) {
    const found = metadata.packages
      .filter((candidate) => candidate.name === name)
      .map(
        (candidate) =>
          `${candidate.version} from ${candidate.source ?? "workspace"}`,
      )
      .join(", ");
    throw new Error(
      `${name} must resolve exactly once to ${version} from ${source ?? "workspace"}; ` +
        `found ${found || "nothing"}`,
    );
  }
  return matches[0];
};

const assertDependency = (parent, dependencyName, dependency) => {
  const node = resolveNodes.get(parent.id);
  if (!node) {
    throw new Error(`Cargo metadata has no resolve node for ${parent.id}`);
  }
  const matches = node.deps.filter(
    (candidate) =>
      candidate.name === dependencyName && candidate.pkg === dependency.id,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${parent.name} ${parent.version} must resolve dependency ${dependencyName} ` +
        `to ${dependency.name} ${dependency.version} (${dependency.id})`,
    );
  }
};

const desktop = resolvedPackage("ccsm-desktop", "0.1.0-beta.6", null);
const tauri = resolvedPackage("tauri", "2.11.5", cratesIoSource);
const tao = resolvedPackage("tao", "0.35.3", taoFixSource);
const wry = resolvedPackage("wry", "0.55.1", cratesIoSource);
const tauriRuntime = resolvedPackage(
  "tauri-runtime",
  "2.11.3",
  cratesIoSource,
);
const tauriRuntimeWry = resolvedPackage(
  "tauri-runtime-wry",
  "2.11.4",
  cratesIoSource,
);
const tauriUtils = resolvedPackage("tauri-utils", "2.9.3", cratesIoSource);

assertDependency(desktop, "tauri", tauri);
assertDependency(tauri, "tauri_runtime", tauriRuntime);
assertDependency(tauri, "tauri_runtime_wry", tauriRuntimeWry);
assertDependency(tauri, "tauri_utils", tauriUtils);
assertDependency(tauriRuntime, "tauri_utils", tauriUtils);
assertDependency(tauriRuntimeWry, "tao", tao);
assertDependency(tauriRuntimeWry, "tauri_runtime", tauriRuntime);
assertDependency(tauriRuntimeWry, "tauri_utils", tauriUtils);
assertDependency(tauriRuntimeWry, "wry", wry);

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
