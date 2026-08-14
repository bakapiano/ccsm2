import { describe, expect, test } from "bun:test";

import type { GitFileChangeDto } from "./generated/GitFileChangeDto";
import type { GitFileDiffDto } from "./generated/GitFileDiffDto";
import type { GitRepositoryStatusDto } from "./generated/GitRepositoryStatusDto";
import {
  flattenGitDiff,
  gitChangeBadge,
  gitChangeMatchesFilter,
  gitDiffContentColumns,
  gitFileName,
  gitParentPath,
} from "./git-diff-model";

const change: GitFileChangeDto = {
  path: "src/example.ts",
  originalPath: null,
  indexStatus: "",
  worktreeStatus: "M",
  kind: "modified",
};

const repository: GitRepositoryStatusDto = {
  repositoryId: "repository",
  relativePath: "packages/app",
  rootPath: "C:/workspace/packages/app",
  branch: "feature/changes",
  files: [change],
  capturedAt: 1n,
  error: null,
};

describe("Git diff presentation model", () => {
  test("flattens hunk headers and source lines for diff rows", () => {
    const diff: GitFileDiffDto = {
      repositoryId: "repository",
      path: change.path,
      originalPath: null,
      additions: 1,
      deletions: 1,
      binary: false,
      truncated: false,
      hunks: [
        {
          header: "@@ -4,2 +4,2 @@",
          oldStart: 4,
          oldLines: 2,
          newStart: 4,
          newLines: 2,
          lines: [
            {
              kind: "deleted",
              oldLine: 4,
              newLine: null,
              content: "const oldValue = 1;",
            },
            {
              kind: "added",
              oldLine: null,
              newLine: 4,
              content: "const newValue = 2;",
            },
          ],
        },
      ],
    };

    expect(flattenGitDiff(diff)).toEqual([
      {
        kind: "hunk",
        oldLine: null,
        newLine: null,
        content: "@@ -4,2 +4,2 @@",
      },
      {
        kind: "deleted",
        oldLine: 4,
        newLine: null,
        content: "const oldValue = 1;",
      },
      {
        kind: "added",
        oldLine: null,
        newLine: 4,
        content: "const newValue = 2;",
      },
    ]);
  });

  test("filters across repository, branch, path, and change kind", () => {
    expect(gitChangeMatchesFilter(repository, change, "example feature")).toBe(
      true,
    );
    expect(
      gitChangeMatchesFilter(repository, change, "packages modified"),
    ).toBe(true);
    expect(gitChangeMatchesFilter(repository, change, "markdown")).toBe(false);
  });

  test("derives compact file labels and status badges", () => {
    expect(gitChangeBadge(change)).toBe("M");
    expect(gitFileName(change.path)).toBe("example.ts");
    expect(gitParentPath(change.path)).toBe("src");
  });

  test("measures tabs, wide glyphs, and combining marks for virtual chunks", () => {
    expect(
      gitDiffContentColumns([
        { kind: "context", oldLine: 1, newLine: 1, content: "ab\tc" },
        {
          kind: "added",
          oldLine: null,
          newLine: 2,
          content: "A界e\u0301",
        },
      ]),
    ).toBe(9);
  });
});
