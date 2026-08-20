import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");

export function nextInstalledUpdateVersion(version) {
  const match = version.match(/^(\d+\.\d+\.\d+-.*?\.)(\d+)$/u);
  if (!match) {
    throw new Error(
      `E2E base version must end in a numeric prerelease: ${version}`,
    );
  }
  return `${match[1]}${Number(match[2]) + 1}`;
}

export function installedUpdateConfig({ endpointPort, publicKey }) {
  const endpointRoot = `http://127.0.0.1:${endpointPort}`;
  return {
    plugins: {
      updater: {
        dangerousInsecureTransportProtocol: true,
        endpoints: [
          `${endpointRoot}/unavailable/latest.json`,
          `${endpointRoot}/primary/latest.json`,
          `${endpointRoot}/fallback/latest.json`,
        ],
        pubkey: publicKey,
        windows: { installMode: "passive" },
      },
    },
  };
}

export function prepareInstalledUpdateE2e({
  outputDirectory,
  publicKeyFile,
  endpointPort,
}) {
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const baseVersion = packageJson.version;
  const candidateVersion = nextInstalledUpdateVersion(baseVersion);
  const publicKey = readFileSync(resolve(publicKeyFile), "utf8").trim();
  if (!publicKey) throw new Error("updater E2E public key is empty");
  if (
    !Number.isInteger(endpointPort) ||
    endpointPort < 1024 ||
    endpointPort > 65535
  ) {
    throw new Error(`invalid updater E2E endpoint port: ${endpointPort}`);
  }

  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const updaterConfigPath = resolve(output, "updater-e2e.conf.json");
  const candidateConfigPath = resolve(output, "candidate-version.conf.json");
  const metadataPath = resolve(output, "metadata.json");
  writeJson(
    updaterConfigPath,
    installedUpdateConfig({ endpointPort, publicKey }),
  );
  writeJson(candidateConfigPath, {
    version: candidateVersion,
    bundle: { createUpdaterArtifacts: true },
  });
  const metadata = {
    baseVersion,
    candidateVersion,
    endpointPort,
    updaterConfigPath,
    candidateConfigPath,
  };
  writeJson(metadataPath, metadata);
  return { ...metadata, metadataPath };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArguments(values) {
  const arguments_ = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    arguments_.set(name.slice(2), value);
  }
  for (const name of ["output-dir", "public-key-file", "endpoint-port"]) {
    if (!arguments_.has(name)) throw new Error(`--${name} is required`);
  }
  return arguments_;
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = prepareInstalledUpdateE2e({
    outputDirectory: arguments_.get("output-dir"),
    publicKeyFile: arguments_.get("public-key-file"),
    endpointPort: Number(arguments_.get("endpoint-port")),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
