/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using the Windows Terminal automatic URL pattern.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { ILink, ILinkProvider } from "../types";
import type { WrappedLineBuffer } from "../wrapped-buffer-line";
import { extractRenderedLinkLines, linkRanges } from "../rendered-link-line";

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

    for (const extracted of extractRenderedLinkLines(
      this.terminal.buffer.active,
      y,
    )) {
      // Reset regex state (global flag maintains state)
      UrlRegexProvider.URL_REGEX.lastIndex = 0;

      // Find all URL matches in the reconstructed logical line.
      let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(
        extracted.text,
      );
      while (match !== null) {
        const url = match[0];
        const startIndex = match.index;
        const endIndex = match.index + url.length;
        const ranges = linkRanges(
          this.terminal.buffer.active,
          extracted.positions,
          startIndex,
          endIndex,
        );
        for (const range of ranges) {
          links.push({
            text: url,
            range,
            ranges,
            activate: (event) => this.linkHandler(url, event),
          });
        }

        // Get next match
        match = UrlRegexProvider.URL_REGEX.exec(extracted.text);
      }
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
