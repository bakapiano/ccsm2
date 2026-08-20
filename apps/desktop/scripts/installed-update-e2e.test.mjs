import assert from "node:assert/strict";
import test from "node:test";

import {
  installedUpdateConfig,
  nextInstalledUpdateVersion,
} from "./prepare-installed-update-e2e.mjs";
import {
  assertInstalledUpdateRequestTrace,
  createInstalledUpdateManifest,
} from "./run-installed-update-e2e.mjs";

test("prepares a numeric A to B prerelease update", () => {
  assert.equal(nextInstalledUpdateVersion("0.1.0-beta.7"), "0.1.0-beta.8");
  assert.throws(() => nextInstalledUpdateVersion("0.1.0"));
});

test("configures ordered local endpoint fallback with the test trust root", () => {
  const config = installedUpdateConfig({
    endpointPort: 43123,
    publicKey: "test-public-key",
  });
  assert.deepEqual(config.plugins.updater.endpoints, [
    "http://127.0.0.1:43123/unavailable/latest.json",
    "http://127.0.0.1:43123/primary/latest.json",
    "http://127.0.0.1:43123/fallback/latest.json",
  ]);
  assert.equal(config.plugins.updater.pubkey, "test-public-key");
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, true);
});

test("serves the exact installed bundle target and validates fallback trace", () => {
  const manifest = createInstalledUpdateManifest({
    version: "0.1.0-beta.8",
    target: "windows-x86_64-nsis",
    artifactUrl: "http://127.0.0.1:43123/artifacts/update.exe",
    signature: "signature",
  });
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64-nsis"]);
  assert.equal(
    manifest.platforms["windows-x86_64-nsis"].signature,
    "signature",
  );
  assert.doesNotThrow(() =>
    assertInstalledUpdateRequestTrace(
      [
        "/unavailable/latest.json",
        "/primary/latest.json",
        "/primary/update.exe",
        "/fallback/latest.json",
        "/artifacts/update.exe",
      ],
      "update.exe",
    ),
  );
  assert.throws(() =>
    assertInstalledUpdateRequestTrace(
      ["/primary/latest.json", "/artifacts/update.exe"],
      "update.exe",
    ),
  );
});
