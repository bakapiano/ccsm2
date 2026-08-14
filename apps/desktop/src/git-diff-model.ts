import type { GitDiffLineKind } from "./generated/GitDiffLineKind";
import type { GitFileChangeDto } from "./generated/GitFileChangeDto";
import type { GitFileDiffDto } from "./generated/GitFileDiffDto";
import type { GitRepositoryStatusDto } from "./generated/GitRepositoryStatusDto";

export type GitDisplayLineKind = GitDiffLineKind | "hunk";

export interface GitDisplayLine {
  kind: GitDisplayLineKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export function gitChangeKey(repositoryId: string, path: string): string {
  return `${repositoryId}\0${path}`;
}

export function flattenGitDiff(diff: GitFileDiffDto): GitDisplayLine[] {
  return diff.hunks.flatMap((hunk) => [
    {
      kind: "hunk" as const,
      oldLine: null,
      newLine: null,
      content: hunk.header,
    },
    ...hunk.lines.map((line) => ({ ...line })),
  ]);
}

export function gitDiffContentColumns(
  lines: readonly GitDisplayLine[],
  tabSize = 8,
): number {
  return lines.reduce(
    (maximum, line) =>
      Math.max(maximum, textDisplayColumns(line.content, tabSize)),
    0,
  );
}

export function gitChangeMatchesFilter(
  repository: GitRepositoryStatusDto,
  change: GitFileChangeDto,
  filter: string,
): boolean {
  const terms = filter.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    repository.relativePath,
    repository.branch ?? "",
    change.path,
    change.originalPath ?? "",
    change.kind,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function gitChangeBadge(change: GitFileChangeDto): string {
  switch (change.kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}

export function gitFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").at(-1) || path;
}

export function gitParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function textDisplayColumns(value: string, tabSize: number): number {
  let columns = 0;
  const resolvedTabSize = Math.max(1, Math.floor(tabSize));
  for (const character of value) {
    if (character === "\t") {
      columns += resolvedTabSize - (columns % resolvedTabSize);
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint)) continue;
    columns += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return columns;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
