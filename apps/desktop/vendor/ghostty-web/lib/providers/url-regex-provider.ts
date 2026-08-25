/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using the Windows Terminal automatic URL pattern.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { ILink, ILinkProvider } from "../types";
import {
  extractWrappedLine,
  type WrappedLineBuffer,
} from "../wrapped-buffer-line";

/**
 * URL Regex Provider
 *
 * Detects plain text URLs on a logical line using regex.
 * Supports terminal soft wrapping but excludes file paths.
 *
 * Supported protocols: http://, https://, ftp:// and file://.
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Ported from microsoft/terminal Terminal::_getPatterns.
   * Keep this case-sensitive and boundary-aware to preserve its behavior.
   */
  private static readonly URL_REGEX =
    /\b(?:https?|ftp|file):\/\/[-A-Za-z0-9+&@#/%?=~_|$!:,.;]*[A-Za-z0-9+&@#/%=~_|$]/g;

  constructor(
    private terminal: ITerminalForUrlProvider,
    private readonly linkHandler: (
      uri: string,
      event: MouseEvent,
    ) => void = defaultLinkHandler,
  ) {}

  /**
   * Provide all regex-detected URLs on the given row
   */
  provideLinks(
    y: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const links: ILink[] = [];

    const extracted = extractWrappedLine(this.terminal.buffer.active, y);
    if (!extracted) {
      callback(undefined);
      return;
    }

    // Reset regex state (global flag maintains state)
    UrlRegexProvider.URL_REGEX.lastIndex = 0;

    // Find all URL matches in the reconstructed logical line.
    let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(
      extracted.text,
    );
    while (match !== null) {
      const url = match[0];
      const startIndex = match.index;
      const endIndex = match.index + url.length - 1;
      const start = extracted.positions[startIndex];
      const end = extracted.positions[endIndex];
      if (start && end) {
        links.push({
          text: url,
          range: { start, end },
          activate: (event) => this.linkHandler(url, event),
        });
      }

      // Get next match
      match = UrlRegexProvider.URL_REGEX.exec(extracted.text);
    }

    callback(links.length > 0 ? links : undefined);
  }

  dispose(): void {
    // No resources to clean up
  }
}

function defaultLinkHandler(uri: string): void {
  window.open(uri, "_blank", "noopener,noreferrer");
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export interface ITerminalForUrlProvider {
  buffer: {
    active: WrappedLineBuffer;
  };
}
