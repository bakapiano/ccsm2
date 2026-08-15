/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using regex pattern matching.
 * Supports common protocols but excludes file paths.
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
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Matches common protocols followed by valid URL characters
   * Excludes file paths (no ./ or ../ or bare /)
   */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%]+/gi;

  /**
   * Characters to strip from end of URLs
   * Common punctuation that's unlikely to be part of the URL
   */
  private static readonly TRAILING_PUNCTUATION = /[.,;!?)\]]+$/;

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
      let url = match[0];
      const startIndex = match.index;
      let endIndex = match.index + url.length - 1;

      // Strip trailing punctuation
      const stripped = url.replace(UrlRegexProvider.TRAILING_PUNCTUATION, "");
      if (stripped.length < url.length) {
        url = stripped;
        endIndex = startIndex + url.length - 1;
      }

      // Skip if URL is too short (e.g., just "http://")
      if (url.length > 8) {
        const start = extracted.positions[startIndex];
        const end = extracted.positions[endIndex];
        if (start && end) {
          links.push({
            text: url,
            range: { start, end },
            activate: (event) => this.linkHandler(url, event),
          });
        }
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
