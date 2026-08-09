import { describe, expect, test } from "bun:test";

import type { GitSnapshotDto } from "./generated/GitSnapshotDto";
import { affectedLoadedDirectories, gitChangeNeedsScan } from "./scan-routing";

const hint = (relativePaths: string[], overflow = false) => ({
  rootId: "root-1",
  relativePaths,
  overflow,
});

describe("background scan event routing", () => {
  test("Files refreshes only a loaded directory whose immediate contents changed", () => {
    const loaded = ["", "src", "src/components"];
    expect(affectedLoadedDirectories(hint(["src/main.ts"]), loaded)).toEqual([
      "src",
    ]);
    expect(
      affectedLoadedDirectories(hint(["src/components/Button.ts"]), loaded),
    ).toEqual(["src/components"]);
    expect(
      affectedLoadedDirectories(hint(["unopened/deep/file.ts"]), loaded),
    ).toEqual([]);
  });

  test("filters CCSM runtime churn and refreshes everything after overflow", () => {
    const loaded = ["", ".ccsm", "AppData/Local/dev.ccsm.desktop"];
    expect(
      affectedLoadedDirectories(
        hint([
          ".ccsm/sessions.json",
          "AppData/Local/dev.ccsm.desktop/data.db-wal",
        ]),
        loaded,
      ),
    ).toEqual([]);
    expect(affectedLoadedDirectories(hint([], true), loaded)).toEqual(loaded);
  });

  test("Git responds only to paths inside a discovered repository", () => {
    const snapshot: GitSnapshotDto = {
      spaceId: "space-1",
      rootId: "root-1",
      scanGeneration: 1,
      repositories: [
        {
          repositoryId: "repo-1",
          relativePath: "dev/project",
          rootPath: "C:\\Users\\me\\dev\\project",
          branch: "main",
          files: [],
          capturedAt: 0n,
          error: null,
        },
      ],
    };
    expect(
      gitChangeNeedsScan(hint(["dev/project/src/main.ts"]), snapshot),
    ).toBe(true);
    expect(gitChangeNeedsScan(hint([".ccsm/sessions.json"]), snapshot)).toBe(
      false,
    );
    expect(gitChangeNeedsScan(hint(["Downloads/bundle.zip"]), snapshot)).toBe(
      false,
    );
    expect(gitChangeNeedsScan(hint(["new-repo/.git/HEAD"]), snapshot)).toBe(
      true,
    );
  });
});
