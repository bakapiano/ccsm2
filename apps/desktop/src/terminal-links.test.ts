import { describe, expect, test } from "bun:test";

import {
  FilePathLinkProvider,
  classifyTerminalUri,
  findTerminalFileReferences,
} from "./terminal-links";

describe("terminal links", () => {
  test.each(["Claude", "Codex", "GitHub Copilot"])(
    "detects file references rendered by %s",
    (provider) => {
      const [reference] = findTerminalFileReferences(
        `${provider}: specs/README.md:1:2`,
      );
      expect(reference).toMatchObject({
        path: "specs/README.md",
        line: 1,
        column: 2,
      });
    },
  );

  test("parses Windows absolute paths from the right of the drive colon", () => {
    const [reference] = findTerminalFileReferences(
      String.raw`D:\repo\src\main.rs:42:7`,
    );
    expect(reference).toMatchObject({
      path: String.raw`D:\repo\src\main.rs`,
      line: 42,
      column: 7,
    });
  });

  test("supports quoted paths containing spaces", () => {
    const [reference] = findTerminalFileReferences(
      String.raw`"D:\repo\file name.ts":20:3`,
    );
    expect(reference).toMatchObject({
      path: String.raw`D:\repo\file name.ts`,
      line: 20,
      column: 3,
    });
  });

  test("does not confuse web URLs with file paths", () => {
    expect(findTerminalFileReferences("https://example.com/a/b")).toEqual([]);
  });

  test("classifies internal browser and file URIs", () => {
    expect(classifyTerminalUri("https://example.com/docs")).toEqual({
      kind: "web",
      url: "https://example.com/docs",
    });
    expect(classifyTerminalUri("file:///D:/repo/src/main.rs#L9C4")).toEqual({
      kind: "file",
      reference: expect.objectContaining({
        path: "D:/repo/src/main.rs",
        line: 9,
        column: 4,
      }),
    });
  });

  test("maps text offsets to terminal columns and requires Ctrl/Cmd activation", async () => {
    const text = "中文 specs/README.md:3:4";
    const cells = Array.from(text).map((character) => ({
      getCodepoint: () => character.codePointAt(0) ?? 0,
      getHyperlinkId: () => 0,
      getWidth: () => (/^[\u0000-\u00ff]$/u.test(character) ? 1 : 2),
      isBold: () => false,
      isItalic: () => false,
      isDim: () => false,
    }));
    const activated: string[] = [];
    const provider = new FilePathLinkProvider(
      {
        buffer: {
          active: {
            getLine: () => ({
              length: cells.length,
              getCell: (x: number) => cells[x],
              translateToString: () => text,
            }),
          },
        },
      } as any,
      (reference) => activated.push(reference.path),
    );
    const links = await new Promise<
      Parameters<Parameters<typeof provider.provideLinks>[1]>[0]
    >((resolve) => provider.provideLinks(0, resolve));

    expect(links?.[0].range.start.x).toBe(3);
    links?.[0].activate({ ctrlKey: false, metaKey: false } as MouseEvent);
    links?.[0].activate({ ctrlKey: true, metaKey: false } as MouseEvent);
    expect(activated).toEqual(["specs/README.md"]);
  });
});
