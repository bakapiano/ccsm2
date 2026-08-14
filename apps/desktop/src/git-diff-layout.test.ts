import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const provider = await Bun.file(
  new URL("./tabs/git-provider.ts", import.meta.url),
).text();
const fileExplorerProvider = await Bun.file(
  new URL("./tabs/file-explorer-provider.ts", import.meta.url),
).text();

describe("Changes diff layout", () => {
  test("keeps the diff and file navigation in a bounded split", () => {
    expect(cssRule(".git-panel")).toContain(
      "grid-template-rows: 36px 30px minmax(0, 1fr)",
    );
    expect(cssRule(".git-changes-layout")).toContain(
      "grid-template-columns: minmax(260px, 1fr) clamp(180px, 28%, 220px)",
    );
    expect(cssRule(".git-diff-pane")).toContain("overflow: auto");
    expect(cssRule(".git-diff-file-header")).toContain("position: sticky");
    expect(cssRule(".git-diff-file-header")).toContain(
      "grid-template-columns: 16px 16px minmax(0, 1fr) auto",
    );
    expect(cssRule(".git-diff-row")).toContain(
      "grid-template-columns: 44px 44px 22px max-content",
    );
    expect(cssRule(".git-diff-file-body[hidden]")).toContain(
      "content-visibility: hidden",
    );
    expect(cssRule(".git-diff-list.is-virtualized .git-diff-chunk")).toContain(
      "content-visibility: auto",
    );
    expect(cssRule(".git-diff-list.is-virtualized .git-diff-chunk")).toContain(
      "contain-intrinsic-block-size",
    );
  });

  test("shares file resource icons and keeps Git status lightweight", () => {
    expect(
      provider.match(/createFileResourceIcon\(change\.path\)/g),
    ).toHaveLength(2);
    expect(fileExplorerProvider).toContain("createFileResourceIcon(");
    expect(provider).toContain("git-navigation-file-status");
    expect(provider).not.toContain("git-navigation-file-badge");
    expect(cssRule(".git-navigation-file")).toContain(
      "grid-template-columns: 16px minmax(0, 1fr) 12px",
    );
    expect(cssRule(".git-navigation-file-status")).not.toContain("border:");
  });

  test("loads structured diffs and applies language token highlighting", () => {
    expect(provider).toContain("readGitDiff");
    expect(provider).toContain("highlightTree(tree, classHighlighter");
    expect(provider).toContain("LanguageDescription.matchFilename");
    expect(provider).toContain("Math.min(4, queue.length)");
    expect(provider).toContain("DIFF_CHUNK_SIZE = 64");
    expect(provider).toContain("document.elementFromPoint");
  });
});

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g")),
  ];
  if (matches.length === 0) throw new Error(`missing CSS rule: ${selector}`);
  return matches
    .map((match) => match[1] ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
