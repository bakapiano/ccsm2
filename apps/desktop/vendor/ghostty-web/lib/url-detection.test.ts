/**
 * URL Detection Tests
 *
 * Tests for the UrlRegexProvider to ensure plain text URLs
 * are correctly detected and made clickable.
 */

import { describe, expect, test } from 'bun:test';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { ILink } from './types';

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
