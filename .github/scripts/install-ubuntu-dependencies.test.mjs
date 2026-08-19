import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const installer = join(scriptDirectory, "install-ubuntu-dependencies.sh");

function bashExecutable() {
  if (process.env.CCSM_TEST_BASH) {
    return process.env.CCSM_TEST_BASH;
  }
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (existsSync(gitBash)) {
      return gitBash;
    }
  }
  return "bash";
}

function bashPath(path) {
  const absolute = resolve(path);
  if (process.platform !== "win32") {
    return absolute;
  }
  const drive = absolute[0].toLowerCase();
  return `/${drive}/${absolute.slice(3).replaceAll("\\", "/")}`;
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function runInstaller({ failUpdate = 0, failDownload = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ccsm-apt-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const aptLog = join(root, "apt.log");
  const timeoutLog = join(root, "timeout.log");
  const mirrorFile = join(root, "apt-mirrors.txt");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(mirrorFile, "http://azure.archive.ubuntu.com/ubuntu/\n");

  writeExecutable(
    join(bin, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_TIMEOUT_LOG"
while [[ "$1" == --* ]]; do
  shift
done
shift
exec "$@"
`,
  );
  writeExecutable(
    join(bin, "apt-get"),
    `#!/usr/bin/env bash
set -euo pipefail
operation=install
for argument in "$@"; do
  if [[ "$argument" == "update" ]]; then
    operation=update
  elif [[ "$argument" == "--download-only" ]]; then
    operation=download
  fi
done
printf '%s|%s\\n' "$operation" "$*" >>"$FAKE_APT_LOG"
count_file="$FAKE_APT_STATE_DIR/$operation"
count=0
if [[ -f "$count_file" ]]; then
  count="$(<"$count_file")"
fi
count=$((count + 1))
printf '%s\\n' "$count" >"$count_file"
failure_limit=0
if [[ "$operation" == "update" ]]; then
  failure_limit="$FAKE_APT_FAIL_UPDATE"
elif [[ "$operation" == "download" ]]; then
  failure_limit="$FAKE_APT_FAIL_DOWNLOAD"
fi
if ((count <= failure_limit)); then
  exit 42
fi
`,
  );

  const result = spawnSync(
    bashExecutable(),
    [bashPath(installer), "build-essential", "libwebkit2gtk-4.1-dev"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        CCSM_APT_ALLOW_NON_ROOT: "1",
        CCSM_APT_GET_COMMAND: bashPath(join(bin, "apt-get")),
        CCSM_APT_MIRROR_FILE: bashPath(mirrorFile),
        CCSM_APT_MAX_ATTEMPTS: "2",
        CCSM_APT_RETRY_DELAY_SECONDS: "0",
        CCSM_APT_UPDATE_TIMEOUT_SECONDS: "12",
        CCSM_APT_DOWNLOAD_TIMEOUT_SECONDS: "34",
        CCSM_TIMEOUT_COMMAND: bashPath(join(bin, "timeout")),
        FAKE_APT_FAIL_UPDATE: String(failUpdate),
        FAKE_APT_FAIL_DOWNLOAD: String(failDownload),
        FAKE_APT_LOG: bashPath(aptLog),
        FAKE_APT_STATE_DIR: bashPath(state),
        FAKE_TIMEOUT_LOG: bashPath(timeoutLog),
      },
    },
  );

  return {
    aptCalls: existsSync(aptLog)
      ? readFileSync(aptLog, "utf8").trim().split("\n")
      : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    mirror: readFileSync(mirrorFile, "utf8"),
    result,
    timeoutCalls: existsSync(timeoutLog)
      ? readFileSync(timeoutLog, "utf8").trim().split("\n")
      : [],
  };
}

test("uses the official HTTPS mirror and separates download from install", () => {
  const run = runInstaller();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    assert.equal(
      run.mirror,
      "https://archive.ubuntu.com/ubuntu/\tpriority:1\n",
    );
    assert.deepEqual(
      run.aptCalls.map((call) => call.split("|", 1)[0]),
      ["update", "download", "install"],
    );
    assert.match(run.aptCalls[1], /--download-only/);
    assert.doesNotMatch(run.aptCalls[2], /--download-only/);
    assert.match(run.aptCalls[2], /--no-download/);
    assert.equal(run.timeoutCalls.length, 2);
    assert.match(run.timeoutCalls[0], /12s .*apt-get/);
    assert.match(run.timeoutCalls[1], /34s .*apt-get/);
  } finally {
    run.cleanup();
  }
});

test("retries transient index and package download failures", () => {
  const run = runInstaller({ failUpdate: 1, failDownload: 1 });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    assert.deepEqual(
      run.aptCalls.map((call) => call.split("|", 1)[0]),
      ["update", "update", "download", "download", "install"],
    );
    assert.equal(run.timeoutCalls.length, 4);
    assert.match(run.result.stdout, /APT index update will retry/);
    assert.match(run.result.stdout, /APT package download will retry/);
  } finally {
    run.cleanup();
  }
});

test("stops after the configured number of attempts", () => {
  const run = runInstaller({ failUpdate: 2 });
  try {
    assert.equal(run.result.status, 42);
    assert.deepEqual(
      run.aptCalls.map((call) => call.split("|", 1)[0]),
      ["update", "update"],
    );
    assert.equal(run.timeoutCalls.length, 2);
    assert.match(run.result.stdout, /APT index update exhausted retries/);
  } finally {
    run.cleanup();
  }
});
