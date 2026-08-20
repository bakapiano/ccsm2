import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("locks the updater trust root and endpoint transport", () => {
  const config = readJson("apps/desktop/src-tauri/tauri.conf.json");
  const updater = config.plugins.updater;

  assert.ok(updater.endpoints.length >= 1);
  for (const endpoint of updater.endpoints) {
    assert.equal(new URL(endpoint).protocol, "https:");
  }
  assert.equal(updater.windows.installMode, "passive");
  assert.match(
    Buffer.from(updater.pubkey, "base64").toString("utf8"),
    /^untrusted comment: minisign public key:/u,
  );
});

test("builds the three current installer targets with updater artifacts", () => {
  const release = readJson("apps/desktop/src-tauri/tauri.release.conf.json");
  const windows = readJson("apps/desktop/src-tauri/tauri.windows.conf.json");
  const linux = readJson("apps/desktop/src-tauri/tauri.linux.conf.json");

  assert.equal(release.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(windows.bundle.targets, ["nsis"]);
  assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(
    windows.bundle.windows.nsis.installerHooks,
    "windows/nsis-hooks.nsh",
  );
  assert.equal(
    windows.bundle.resources[
      "../../../crates/ccsm-platform/vendor/conpty/conpty.dll"
    ],
    "conpty/conpty.dll",
  );
  assert.deepEqual(linux.bundle.targets, ["deb", "appimage"]);
  assert.equal(linux.bundle.linux.appimage.bundleMediaFramework, true);
});

test("publishes the signed raw AppImage consumed by the current updater", () => {
  const packager = readFileSync("scripts/package-ubuntu.sh", "utf8");
  const manifest = readFileSync("scripts/generate-update-manifest.mjs", "utf8");

  assert.match(packager, /appimage_signature="\$\{appimage_path\}\.sig"/u);
  assert.match(packager, /linux-x86_64\.AppImage"/u);
  assert.doesNotMatch(packager, /AppImage\.tar\.gz/u);
  assert.match(manifest, /linux-x86_64\.AppImage`/u);
  assert.doesNotMatch(manifest, /AppImage\.tar\.gz/u);
});

test("runs signed installed A to B updates in both desktop E2E jobs", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const windows = readFileSync("scripts/test-windows-package.ps1", "utf8");
  const linux = readFileSync("scripts/test-linux-packages.sh", "utf8");

  assert.match(workflow, /Build Windows A\/B updater E2E packages/u);
  assert.match(workflow, /Build Linux A\/B updater E2E packages/u);
  assert.match(workflow, /prepare-installed-update-e2e\.mjs/u);
  assert.match(workflow, /Install and update Windows E2E package/u);
  assert.match(windows, /run-installed-update-e2e\.mjs/u);
  assert.match(windows, /windows-x86_64-nsis/u);
  assert.match(linux, /linux-x86_64-deb/u);
  assert.match(linux, /linux-x86_64-appimage/u);
  const runner = readFileSync(
    "apps/desktop/scripts/run-installed-update-e2e.mjs",
    "utf8",
  );
  const updater = readFileSync("apps/desktop/src-tauri/src/updates.rs", "utf8");
  assert.match(runner, /waitForWindowsRestart/u);
  assert.match(runner, /automaticRestartPid/u);
  assert.match(runner, /CCSM_E2E_WINDOWS_UPDATER_HANDOFF_FILE/u);
  assert.match(runner, /verified handoff bytes/u);
  assert.match(updater, /\["\/P", "\/UPDATE"\]/u);
  assert.match(updater, /handoff-delay-complete/u);
  assert.match(updater, /CREATE_BREAKAWAY_FROM_JOB/u);
});

test("generates ephemeral updater signing passwords in both E2E jobs", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

  assert.equal(workflow.match(/randomBytes\(32\)/gu)?.length, 2);
  assert.equal(workflow.match(/::add-mask::/gu)?.length, 2);
  assert.match(workflow, /--password \$updateSigningPassword/u);
  assert.match(workflow, /--password "\$\{update_signing_password\}"/u);
});

test("downloads only packaged artifacts when publishing a release", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /pattern: ccsm-\*/u);
});
