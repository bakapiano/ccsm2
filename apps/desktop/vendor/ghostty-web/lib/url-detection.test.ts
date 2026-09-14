/**
 * URL Detection Tests
 *
 * Tests for the UrlRegexProvider to ensure plain text URLs
 * are correctly detected and made clickable.
 */

import { describe, expect, test } from 'bun:test';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { ILink } from './types';
import { linkTestTerminal, providerLinks } from './link-test-harness';
import { LinkDetector } from './link-detector';

/**
 * Mock terminal for testing
 */
function createMockTerminal(input: string | Array<{ text: string; isWrapped?: boolean }>) {
  const rows = typeof input === 'string' ? [{ text: input }] : input;
  const lines = rows.map(({ text, isWrapped = false }) => {
    const cells = Array.from(text).map((char) => ({
      getCodepoint: () => char.codePointAt(0) || 0,
    }));
    return {
      length: cells.length,
      isWrapped,
      getCell: (x: number) => cells[x],
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

/**
 * Helper to get links from provider
 */
function getLinks(
  input: string | Array<{ text: string; isWrapped?: boolean }>,
  y = 0
): Promise<ILink[] | undefined> {
  const terminal = createMockTerminal(input) as any;
  const provider = new UrlRegexProvider(terminal);

  return new Promise((resolve) => {
    provider.provideLinks(y, resolve);
  });
}

describe('URL Detection', () => {
  test.each([80, 37])('opens every unstyled table URL fragment at width %s', async (cols) => {
    const url =
      'https://example.com/ccsm/manual/markdown/table/wrapped/browser/link/target?source=table';
    const terminal = await linkTestTerminal(
      [
        '   Case          Target',
        '   ----------    --------------------------------------------------------',
        '   Browser       Open (https://example.com/ccsm/manual/',
        '                 markdown/table/wrapped/browser/link/target?',
        '                 source=table)',
        '   Other         https://example.com/independent',
        '',
      ].join('\r\n'),
      cols,
      24
    );
    const opened: string[] = [];
    const detector = new LinkDetector(terminal);
    detector.registerProvider(new UrlRegexProvider(terminal, (uri) => opened.push(uri)));
    try {
      const fragments =
        cols === 80
          ? [
              [24, 2],
              [17, 3],
              [27, 4],
            ]
          : [
              [24, 3],
              [17, 5],
              [27, 7],
            ];
      for (const [x, y] of fragments.reverse()) {
        const link = await detector.getLinkAt(x, y);
        expect(link?.text).toBe(url);
        link?.activate({} as MouseEvent);
      }
      expect(opened).toEqual([url, url, url]);
      expect(await detector.getLinkAt(16, cols === 80 ? 3 : 5)).toBeUndefined();
      expect(await detector.getLinkAt(4, cols === 80 ? 2 : 3)).toBeUndefined();
      expect((await detector.getLinkAt(20, cols === 80 ? 5 : 8))?.text).toBe(
        'https://example.com/independent'
      );
    } finally {
      terminal.dispose();
    }
  });

  test('uses cell columns after CJK labels and ends plain table spans at closing delimiters', async () => {
    const terminal = await linkTestTerminal(
      [
        '   Case          Target',
        '   ----------    --------------------------------------------------------',
        '   中文          (https://example.com/table/',
        '                 target)',
        '                 description',
        '   Other         https://example.com/first',
        '                 https://example.com/second',
        '',
      ].join('\r\n')
    );
    const detector = new LinkDetector(terminal);
    detector.registerProvider(new UrlRegexProvider(terminal));
    try {
      expect((await detector.getLinkAt(18, 3))?.text).toBe('https://example.com/table/target');
      expect((await detector.getLinkAt(18, 2))?.range.start).toEqual({ x: 18, y: 2 });
      expect(await detector.getLinkAt(18, 4)).toBeUndefined();
      expect((await detector.getLinkAt(18, 5))?.text).toBe('https://example.com/first');
      expect((await detector.getLinkAt(18, 6))?.text).toBe('https://example.com/second');
    } finally {
      terminal.dispose();
    }
  });

  test('recovers full-width URL rows repainted with hard CRLF by ConPTY', async () => {
    const head = '  https://example.com/a/long/path/';
    const tail = 'target?source=terminal';
    const terminal = await linkTestTerminal(`${head}\r\n${tail}`, head.length);
    try {
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false);
      const provider = new UrlRegexProvider(terminal);
      for (const row of [0, 1]) {
        const links = await providerLinks(provider, row);
        expect(links[0].text).toBe(head.trimStart() + tail);
      }
      terminal.wasmTerm.write('\r\n'.repeat(20));
      expect(terminal.wasmTerm.getScrollbackLength()).toBeGreaterThan(1);
      expect((await providerLinks(provider, 1))[0].text).toBe(head.trimStart() + tail);
    } finally {
      terminal.dispose();
    }
  });
  test('opens every styled Codex table URL fragment with its complete destination', async () => {
    const url =
      'https://example.com/ccsm/e2e/markdown/table/wrapped/browser/link/target?source=table';
    const terminal = await linkTestTerminal(
      [
        '   Table cell       Open nested table link (\x1b[36;4mhttps://example.com/ccsm/e2e/\x1b[0m',
        '                    \x1b[36;4mmarkdown/table/wrapped/browser/link/target?\x1b[0m',
        '                    \x1b[36;4msource=table\x1b[0m)',
      ].join('\r\n')
    );
    const opened: string[] = [];
    const provider = new UrlRegexProvider(terminal, (uri) => opened.push(uri));
    const detector = new LinkDetector(terminal);
    detector.registerProvider(provider);
    try {
      for (const [x, y] of [
        [44, 0],
        [20, 1],
        [25, 2],
      ]) {
        const link = await detector.getLinkAt(x, y);
        expect(link?.text).toBe(url);
        link?.activate({} as MouseEvent);
      }
      expect(opened).toEqual([url, url, url]);
      expect(await detector.getLinkAt(4, 0)).toBeUndefined();
      expect(await detector.getLinkAt(19, 1)).toBeUndefined();
      expect(await detector.getLinkAt(65, 1)).toBeUndefined();
      expect(await detector.getLinkAt(32, 2)).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  test('keeps adjacent complete styled URLs separate', async () => {
    const terminal = await linkTestTerminal(
      '  (\x1b[36;4mhttps://first.example/a\x1b[0m)\r\n  (\x1b[36;4mhttps://second.example/b\x1b[0m)'
    );
    try {
      const provider = new UrlRegexProvider(terminal);
      expect((await providerLinks(provider, 0)).map((link) => link.text)).toEqual([
        'https://first.example/a',
      ]);
      expect((await providerLinks(provider, 1)).map((link) => link.text)).toEqual([
        'https://second.example/b',
      ]);
    } finally {
      terminal.dispose();
    }
  });

  test('keeps styled URL continuations in their table column', async () => {
    const terminal = await linkTestTerminal(
      [
        '  Left              (\x1b[36;4mhttps://example.com/table/\x1b[0m',
        '  \x1b[36;4munrelated\x1b[0m         \x1b[36;4mtarget\x1b[0m)',
      ].join('\r\n')
    );
    try {
      const links = await providerLinks(new UrlRegexProvider(terminal), 1);
      expect(links[0].text).toBe('https://example.com/table/target');
      expect(links.some((link) => link.text.includes('unrelated'))).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  test('maps styled URL fragments after wide CJK cells', async () => {
    const terminal = await linkTestTerminal(
      '中文 (\x1b[36;4mhttps://example.com/long/\x1b[0m\r\n  \x1b[36;4mtarget\x1b[0m)'
    );
    try {
      const links = await providerLinks(new UrlRegexProvider(terminal), 1);
      expect(links[0]).toMatchObject({
        text: 'https://example.com/long/target',
        range: { start: { x: 6, y: 0 } },
      });
      expect(links[1]).toMatchObject({ range: { start: { x: 2, y: 1 }, end: { x: 7, y: 1 } } });
    } finally {
      terminal.dispose();
    }
  });

  test('ends a full-width URL before the next independent file reference', async () => {
    const head = 'https://example.com/long/';
    const terminal = await linkTestTerminal(
      `${head}\r\ntarget?source=terminal\r\ndocs/a/very/long/file/path/target.md:2:3`,
      head.length
    );
    try {
      const links = await providerLinks(new UrlRegexProvider(terminal), 1);
      expect(links[0].text).toBe(head + 'target?source=terminal');
    } finally {
      terminal.dispose();
    }
  });

  test('detects HTTPS URLs', async () => {
    const links = await getLinks('Visit https://github.com for code');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://github.com');
    expect(links?.[0].range.start.x).toBe(6);
    // End is inclusive - last character is at index 23 (https://github.com is 19 chars, starts at 6)
    expect(links?.[0].range.end.x).toBe(23);
  });

  test('detects HTTP URLs', async () => {
    const links = await getLinks('Check http://example.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('http://example.com');
  });

  test('detects file URLs', async () => {
    const links = await getLinks('Open file:///D:/repo/src/main.rs');
    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe('file:///D:/repo/src/main.rs');
  });

  test('detects ftp:// URLs', async () => {
    const links = await getLinks('Download ftp://files.example.com/file');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('ftp://files.example.com/file');
  });

  test('uses the Windows Terminal boundary and casing rules', async () => {
    expect(await getLinks('abchttps://example.com')).toBeUndefined();
    expect(await getLinks('HTTPS://example.com')).toBeUndefined();
    expect((await getLinks('Open http://a'))?.[0].text).toBe('http://a');
  });

  test('keeps schemes outside the Windows Terminal pattern as text', async () => {
    expect(await getLinks('mailto:test@example.com')).toBeUndefined();
    expect(await getLinks('ssh://user@server.com')).toBeUndefined();
    expect(await getLinks('git://github.com/repo.git')).toBeUndefined();
    expect(await getLinks('tel:+1234567890')).toBeUndefined();
    expect(await getLinks('magnet:?xt=urn:btih:abc123')).toBeUndefined();
  });

  test('strips trailing period', async () => {
    const links = await getLinks('Check https://example.com.');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
    // Should NOT include the trailing period
    expect(links?.[0].text.endsWith('.')).toBe(false);
  });

  test('strips trailing comma', async () => {
    const links = await getLinks('See https://example.com, or else');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('strips trailing parenthesis', async () => {
    const links = await getLinks('(see https://example.com)');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('strips trailing exclamation', async () => {
    const links = await getLinks('Visit https://example.com!');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('handles multiple URLs on same line', async () => {
    const links = await getLinks('https://a.com and https://b.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(2);
    expect(links?.[0].text).toBe('https://a.com');
    expect(links?.[1].text).toBe('https://b.com');
  });

  test('returns undefined when no URL present', async () => {
    const links = await getLinks('No URLs here');
    expect(links).toBeUndefined();
  });

  test('handles URLs with query parameters', async () => {
    const links = await getLinks('https://example.com?foo=bar&baz=qux');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com?foo=bar&baz=qux');
  });

  test('handles URLs with fragments', async () => {
    const links = await getLinks('https://example.com/page#section');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com/page#section');
  });

  test('handles URLs with ports', async () => {
    const links = await getLinks('https://example.com:8080/path');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com:8080/path');
  });

  test('reconstructs URLs split by terminal soft wrapping', async () => {
    const secondRow = 'com/docs?view=full';
    const links = await getLinks(
      [{ text: 'Visit https://example.' }, { text: secondRow, isWrapped: true }],
      1
    );

    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: 'https://example.com/docs?view=full',
      range: {
        start: { x: 6, y: 0 },
        end: { x: secondRow.length - 1, y: 1 },
      },
    });
  });

  test('does not join URL fragments across hard line breaks', async () => {
    const links = await getLinks([{ text: 'Visit https://' }, { text: 'example.com/docs' }], 0);

    expect(links).toBeUndefined();
  });

  test('does not detect file paths', async () => {
    const links = await getLinks('/home/user/file.txt');
    expect(links).toBeUndefined();
  });

  test('does not detect relative paths', async () => {
    const links = await getLinks('./relative/path');
    expect(links).toBeUndefined();
  });

  test('link has activate function', async () => {
    const links = await getLinks('https://example.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(typeof links?.[0].activate).toBe('function');
  });

  test('routes activation through the embedder link handler', async () => {
    const opened: string[] = [];
    const provider = new UrlRegexProvider(createMockTerminal('https://example.com') as any, (uri) =>
      opened.push(uri)
    );
    const links = await new Promise<ILink[] | undefined>((resolve) =>
      provider.provideLinks(0, resolve)
    );

    links?.[0].activate({ ctrlKey: true, metaKey: false } as MouseEvent);
    expect(opened).toEqual(['https://example.com']);
  });
});
