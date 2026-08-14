import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const appBinary = process.env.CCSM_E2E_APP_BINARY;
if (!appBinary) {
  throw new Error("CCSM_E2E_APP_BINARY must point to the Linux CCSM binary");
}

const artifactDirectory = resolve(
  process.env.CCSM_E2E_ARTIFACT_DIR ?? "../../artifacts/linux-desktop",
);
mkdirSync(artifactDirectory, { recursive: true });
process.env.CCSM_E2E_ARTIFACT_DIR = artifactDirectory;

let tauriDriver: ChildProcess | undefined;

async function waitForEndpoint(url: string, name: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The driver is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

async function waitForDrivers(): Promise<void> {
  await Promise.all([
    waitForEndpoint("http://127.0.0.1:4444/status", "tauri-driver"),
    waitForEndpoint("http://127.0.0.1:4445/status", "WebKitWebDriver"),
  ]);
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/linux/**/*.spec.ts"],
  maxInstances: 1,
  services: [],
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  capabilities: [
    {
      "tauri:options": {
        application: appBinary,
      },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: process.env.CCSM_E2E_REAL_PROVIDERS === "1" ? 360_000 : 90_000,
  },
  onPrepare: async () => {
    const stdout = createWriteStream(
      resolve(artifactDirectory, "tauri-driver.log"),
    );
    tauriDriver = spawn(
      "tauri-driver",
      [
        "--port",
        "4444",
        "--native-port",
        "4445",
        "--native-driver",
        "/usr/bin/WebKitWebDriver",
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    tauriDriver.stdout?.pipe(stdout);
    tauriDriver.stderr?.pipe(stdout);
    await waitForDrivers();
  },
  onComplete: async () => {
    tauriDriver?.kill("SIGTERM");
  },
};
