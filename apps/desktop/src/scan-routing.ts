import type { FileChangeHintDto } from "./generated/FileChangeHintDto";
import type { GitSnapshotDto } from "./generated/GitSnapshotDto";

export function affectedLoadedDirectories(
  hint: FileChangeHintDto,
  loadedDirectories: Iterable<string>,
): string[] {
  const loaded = new Set([...loadedDirectories].map(normalizeRelativePath));
  if (hint.overflow) return [...loaded];
  const affected = new Set<string>();
  for (const rawPath of hint.relativePaths) {
    const path = normalizeRelativePath(rawPath);
    if (!path || isBackgroundNoisePath(path)) continue;
    const parent = parentPath(path);
    if (loaded.has(parent)) affected.add(parent);
    if (loaded.has(path)) affected.add(path);
    for (const directory of loaded) {
      if (directory.startsWith(`${path}/`)) affected.add(directory);
    }
  }
  return [...affected];
}

export function gitChangeNeedsScan(
  hint: FileChangeHintDto,
  snapshot: GitSnapshotDto | null,
): boolean {
  if (hint.overflow) return true;
  if (snapshot && hint.rootId !== snapshot.rootId) return false;
  const paths = hint.relativePaths
    .map(normalizeRelativePath)
    .filter((path) => path && !isBackgroundNoisePath(path));
  if (paths.length === 0) return false;
  if (!snapshot) return paths.some(isRepositoryMetadataPath);
  return paths.some(
    (path) =>
      snapshot.repositories.some((repository) => {
        const root = normalizeRelativePath(repository.relativePath);
        return root === "." || path === root || path.startsWith(`${root}/`);
      }) || isRepositoryMetadataPath(path),
  );
}

export function isBackgroundNoisePath(rawPath: string): boolean {
  const path = normalizeRelativePath(rawPath).toLowerCase();
  return (
    path === ".ccsm" ||
    path.startsWith(".ccsm/") ||
    path === ".playwright-cli" ||
    path.startsWith(".playwright-cli/") ||
    path === "appdata/local/dev.ccsm.desktop" ||
    path.startsWith("appdata/local/dev.ccsm.desktop/")
  );
}

function isRepositoryMetadataPath(path: string): boolean {
  return (
    path === ".git" ||
    path.startsWith(".git/") ||
    /^[^/]+\/\.git(?:\/|$)/.test(path)
  );
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
