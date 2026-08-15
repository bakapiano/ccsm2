import { describe, expect, test } from "bun:test";

import {
  FilePathLinkProvider,
  classifyTerminalUri,
  detectTerminalPathPlatform,
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
      "windows",
    );
    expect(reference).toMatchObject({
      path: String.raw`D:\repo\src\main.rs`,
      line: 42,
      column: 7,
    });
  });

  test("separates Windows paths from Chinese prose punctuation", () => {
    const [reference] = findTerminalFileReferences(
      "构建产物 D:/repo/target/debug/app.exe，验收完成喵！",
      "windows",
    );
    expect(reference).toMatchObject({
      path: "D:/repo/target/debug/app.exe",
      text: "D:/repo/target/debug/app.exe",
    });
  });

  test("requires a clean boundary before a Windows drive path", () => {
    expect(
      findTerminalFileReferences(
        "/D:/ccsm2_0/ccsm2/target/debug/ccsm-desktop.exe，验收进程已正常退出喵！",
      ),
    ).toEqual([]);
  });

  test("supports quoted paths containing spaces", () => {
    const [reference] = findTerminalFileReferences(
      String.raw`"D:\repo\file name.ts":20:3`,
      "windows",
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
    expect(
      classifyTerminalUri("file:///D:/repo/src/main.rs#L9C4", "windows"),
    ).toEqual({
      kind: "file",
      reference: expect.objectContaining({
        path: "D:/repo/src/main.rs",
        line: 9,
        column: 4,
      }),
    });
  });

  test("selects filename character rules from the host platform", () => {
    expect(detectTerminalPathPlatform("Win32")).toBe("windows");
    expect(detectTerminalPathPlatform("MacIntel")).toBe("macos");
    expect(detectTerminalPathPlatform("Linux x86_64")).toBe("linux");

    expect(
      findTerminalFileReferences(String.raw`"D:\repo\bad*name?.ts"`, "windows"),
    ).toEqual([]);
    const [linuxReference] = findTerminalFileReferences(
      '"/workspace/bad*name?.ts"',
      "linux",
    );
    expect(linuxReference?.path).toBe("/workspace/bad*name?.ts");
  });

  test("maps text offsets to terminal columns and activates on a plain click", async () => {
    const text = "中文 specs/README.md:3:4";
    const activated: string[] = [];
    const provider = new FilePathLinkProvider(
      createMockTerminal([{ text }]),
      (reference) => activated.push(reference.path),
    );
    const links = await new Promise<
      Parameters<Parameters<typeof provider.provideLinks>[1]>[0]
    >((resolve) => provider.provideLinks(0, resolve));

    expect(links?.[0].range.start.x).toBe(3);
    links?.[0].activate({ ctrlKey: false, metaKey: false } as MouseEvent);
    expect(activated).toEqual(["specs/README.md"]);
  });

  test("reconstructs file references split by terminal soft wrapping", async () => {
    const firstRow = "open specs/very/long/";
    const secondRow = "directory/file.ts:42:7";
    const provider = new FilePathLinkProvider(
      createMockTerminal([
        { text: firstRow },
        { text: secondRow, isWrapped: true },
      ]),
      () => {},
    );
    const links = await new Promise<
      Parameters<Parameters<typeof provider.provideLinks>[1]>[0]
    >((resolve) => provider.provideLinks(1, resolve));

    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: "specs/very/long/directory/file.ts:42:7",
      range: {
        start: { x: 5, y: 0 },
        end: { x: secondRow.length - 1, y: 1 },
      },
    });
  });

  test("does not join file references across hard line breaks", async () => {
    const provider = new FilePathLinkProvider(
      createMockTerminal([
        { text: 'open "specs/very/' },
        { text: 'long/file.ts":9' },
      ]),
      () => {},
    );
    const links = await new Promise<
      Parameters<Parameters<typeof provider.provideLinks>[1]>[0]
    >((resolve) => provider.provideLinks(0, resolve));

    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: "specs/very",
      range: { start: { y: 0 }, end: { y: 0 } },
    });
  });
});

function createMockTerminal(
  rows: Array<{ text: string; isWrapped?: boolean }>,
): any {
  const lines = rows.map(({ text, isWrapped = false }) => {
    const cells = Array.from(text).map((character) => ({
      getCodepoint: () => character.codePointAt(0) ?? 0,
      getHyperlinkId: () => 0,
      getWidth: () => (/^[\u0000-\u00ff]$/u.test(character) ? 1 : 2),
      isBold: () => false,
      isItalic: () => false,
      isDim: () => false,
    }));
    return {
      length: cells.length,
      isWrapped,
      getCell: (x: number) => cells[x],
      translateToString: () => text,
    };
  });
  return {
    buffer: {
      active: {
        getLine: (y: number) => lines[y],
      },
    },
  };
}
