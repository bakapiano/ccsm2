import { describe, expect, test } from "bun:test";
import {
  linkTestTerminal,
  providerLinks,
} from "../vendor/ghostty-web/lib/link-test-harness";
import { LinkDetector } from "../vendor/ghostty-web/lib/link-detector";

import {
  FilePathLinkProvider,
  classifyTerminalUri,
  detectTerminalPathPlatform,
  findTerminalFileReferences,
} from "./terminal-links";

describe("terminal links", () => {
  test("opens unstyled table file fragments with the complete path and location", async () => {
    const terminal = await linkTestTerminal(
      [
        "   Case          Target",
        "   ----------    --------------------------------------------------------",
        "   File          docs/manual/wrapped-links/a-very-long-directory-name/",
        "                 with-several-levels/target.md:2:3",
        "   Other         docs/other.md:4:5",
        "",
      ].join("\r\n"),
    );
    const opened: unknown[] = [];
    const detector = new LinkDetector(terminal);
    detector.registerProvider(
      new FilePathLinkProvider(terminal, (value) => opened.push(value)),
    );
    try {
      for (const [x, y] of [
        [18, 3],
        [18, 2],
        [48, 3],
      ]) {
        const link = await detector.getLinkAt(x, y);
        expect(link?.text).toBe(
          "docs/manual/wrapped-links/a-very-long-directory-name/with-several-levels/target.md:2:3",
        );
        link?.activate({} as MouseEvent);
      }
      expect(opened).toHaveLength(3);
      expect(opened[0]).toMatchObject({
        path: "docs/manual/wrapped-links/a-very-long-directory-name/with-several-levels/target.md",
        line: 2,
        column: 3,
      });
      expect((await detector.getLinkAt(18, 4))?.text).toBe("docs/other.md:4:5");
      expect(await detector.getLinkAt(16, 3)).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  test.each([17, 20, 25, 33, 34, 50, 51])(
    "retains wrapped filename extensions and locations at width %s",
    async (cols) => {
      const reference =
        "docs/e2e/windows-terminal-compatible/soft-wrapped/file/path/with/additional/review/context/target.md:2:3";
      for (const hardBreaks of [false, true]) {
        const output = hardBreaks
          ? reference.match(new RegExp(`.{1,${cols}}`, "g"))!.join("\r\n")
          : reference;
        const terminal = await linkTestTerminal(output, cols);
        try {
          const activated: unknown[] = [];
          const detector = new LinkDetector(terminal);
          detector.registerProvider(
            new FilePathLinkProvider(terminal, (value) =>
              activated.push(value),
            ),
          );
          const link = await detector.getLinkAt(0, 1);
          expect(link?.text).toBe(reference);
          link?.activate({} as MouseEvent);
          expect(activated[0]).toMatchObject({
            path: reference.slice(0, -4),
            line: 2,
            column: 3,
          });
        } finally {
          terminal.dispose();
        }
      }
    },
  );
  test("reconstructs full-width paths whose continuation starts with a slash", async () => {
    const head = "docs/e2e/long/file";
    const tail = "/path/target.md:2:3";
    const terminal = await linkTestTerminal(`${head}\r\n${tail}`, head.length);
    try {
      const links = await providerLinks(
        new FilePathLinkProvider(terminal, () => {}),
        1,
      );
      expect(links[0].text).toBe(head + tail);
    } finally {
      terminal.dispose();
    }
  });
  test.each([2, 20])(
    "opens styled hard-wrapped file references in column %s",
    async (indent) => {
      const pad = " ".repeat(indent);
      const terminal = await linkTestTerminal(
        [
          `${pad}\x1b[36mdocs/e2e/markdown/wrapped/file/path/\x1b[0m`,
          `${pad}\x1b[36mwith/review/context/target.md:2:3\x1b[0m`,
        ].join("\r\n"),
      );
      const opened: unknown[] = [];
      const detector = new LinkDetector(terminal);
      detector.registerProvider(
        new FilePathLinkProvider(terminal, (reference) =>
          opened.push(reference),
        ),
      );
      try {
        // Start on the continuation row, as users commonly do after scrolling.
        for (const y of [1, 0]) {
          const link = await detector.getLinkAt(indent + 2, y);
          expect(link?.text).toBe(
            "docs/e2e/markdown/wrapped/file/path/with/review/context/target.md:2:3",
          );
          link?.activate({} as MouseEvent);
          expect(await detector.getLinkAt(indent - 1, y)).toBeUndefined();
          expect(await detector.getLinkAt(79, y)).toBeUndefined();
        }
        expect(opened).toHaveLength(2);
        expect(opened[0]).toMatchObject({
          path: "docs/e2e/markdown/wrapped/file/path/with/review/context/target.md",
          line: 2,
          column: 3,
        });
      } finally {
        terminal.dispose();
      }
    },
  );

  test("keeps adjacent complete styled file references independent", async () => {
    const terminal = await linkTestTerminal(
      "  \x1b[36mdocs/first.md:2:3\x1b[0m\r\n  \x1b[36mdocs/second.md:4:5\x1b[0m",
    );
    try {
      const provider = new FilePathLinkProvider(terminal, () => {});
      expect(
        (await providerLinks(provider, 0)).map((link) => link.text),
      ).toEqual(["docs/first.md:2:3"]);
      expect(
        (await providerLinks(provider, 1)).map((link) => link.text),
      ).toEqual(["docs/second.md:4:5"]);
    } finally {
      terminal.dispose();
    }
  });

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
    expect(classifyTerminalUri("ftp://files.example.com/release")).toEqual({
      kind: "web",
      url: "ftp://files.example.com/release",
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

  test("maps text offsets to terminal columns and activates the reference", async () => {
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
    links?.[0].activate({ ctrlKey: true, metaKey: false } as MouseEvent);
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

  test("reconstructs a Markdown file reference split by terminal soft wrapping", async () => {
    const firstRow = "- `docs/e2e/wrapped/terminal/";
    const secondRow = "markdown/file/path/target.md:42:7`";
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
      text: "`docs/e2e/wrapped/terminal/markdown/file/path/target.md:42:7`",
      range: {
        start: { x: 2, y: 0 },
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
