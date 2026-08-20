import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function generateUpdateManifest({
  version,
  artifactsDirectory,
  baseUrl,
  notes = "",
  pubDate,
}) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid update version: ${version}`);
  }
  const directory = resolve(artifactsDirectory);
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, "");
  const windows = signedArtifact(directory, [
    `CCSM-${version}-windows-x64-setup.exe`,
    `CCSM-${version}-windows-x64.nsis.zip`,
  ]);
  const deb = signedArtifact(directory, [`CCSM-${version}-linux-x86_64.deb`]);
  const appimage = signedArtifact(directory, [
    `CCSM-${version}-linux-x86_64.AppImage`,
  ]);

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64-nsis": platformEntry(windows, normalizedBaseUrl),
      "linux-x86_64-deb": platformEntry(deb, normalizedBaseUrl),
      "linux-x86_64-appimage": platformEntry(appimage, normalizedBaseUrl),
    },
  };
}

function signedArtifact(directory, candidates) {
  for (const name of candidates) {
    const payload = join(directory, name);
    const signature = `${payload}.sig`;
    if (existsSync(payload) && existsSync(signature)) {
      const value = readFileSync(signature, "utf8").trim();
      if (!value) throw new Error(`empty updater signature: ${signature}`);
      return { path: payload, name, signature: value };
    }
  }
  throw new Error(
    `missing signed updater artifact; expected one of ${candidates.join(", ")}`,
  );
}

function platformEntry(artifact, baseUrl) {
  return {
    url: `${baseUrl}/${encodeURIComponent(basename(artifact.path))}`,
    signature: artifact.signature,
  };
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
  }
  for (const required of ["version", "artifacts-dir", "base-url", "output"]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  return values;
}

function main() {
  const values = parseArguments(process.argv.slice(2));
  const notes = values.has("notes-file")
    ? readFileSync(values.get("notes-file"), "utf8").trim()
    : "";
  const manifest = generateUpdateManifest({
    version: values.get("version"),
    artifactsDirectory: values.get("artifacts-dir"),
    baseUrl: values.get("base-url"),
    notes,
    pubDate: values.get("pub-date") ?? new Date().toISOString(),
  });
  writeFileSync(
    resolve(values.get("output")),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
