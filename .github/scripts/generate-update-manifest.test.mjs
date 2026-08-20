import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateUpdateManifest } from "../../scripts/generate-update-manifest.mjs";

test("generates exact installer-specific updater targets", () => {
  const directory = mkdtempSync(join(tmpdir(), "ccsm-update-manifest-"));
  try {
    const version = "0.1.0-beta.7";
    for (const name of [
      `CCSM-${version}-windows-x64-setup.exe`,
      `CCSM-${version}-linux-x86_64.deb`,
      `CCSM-${version}-linux-x86_64.AppImage`,
    ]) {
      writeFileSync(join(directory, name), name);
      writeFileSync(join(directory, `${name}.sig`), `signature-${name}`);
    }

    const manifest = generateUpdateManifest({
      version,
      artifactsDirectory: directory,
      baseUrl: "https://downloads.example.com/release/",
      notes: "Release notes",
      pubDate: "2026-08-20T02:00:00Z",
    });

    assert.equal(manifest.version, version);
    assert.deepEqual(Object.keys(manifest.platforms), [
      "windows-x86_64-nsis",
      "linux-x86_64-deb",
      "linux-x86_64-appimage",
    ]);
    assert.equal(
      manifest.platforms["windows-x86_64-nsis"].url,
      `https://downloads.example.com/release/CCSM-${version}-windows-x64-setup.exe`,
    );
    assert.equal(
      manifest.platforms["linux-x86_64-appimage"].signature,
      `signature-CCSM-${version}-linux-x86_64.AppImage`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires a signature beside every updater payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "ccsm-update-manifest-"));
  try {
    assert.throws(
      () =>
        generateUpdateManifest({
          version: "0.1.0-beta.7",
          artifactsDirectory: directory,
          baseUrl: "https://downloads.example.com/release",
          pubDate: "2026-08-20T02:00:00Z",
        }),
      /missing signed updater artifact/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
