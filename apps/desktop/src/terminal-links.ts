import type { ILink, ILinkProvider } from "../vendor/ghostty-web/lib/types";
import {
  extractWrappedLine,
  type WrappedLineBuffer,
} from "../vendor/ghostty-web/lib/wrapped-buffer-line";

export interface TerminalFileReference {
  path: string;
  line: number | null;
  column: number | null;
  text: string;
  startIndex: number;
  endIndex: number;
}

export type TerminalPathPlatform = "windows" | "macos" | "linux";

export type TerminalLinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; reference: TerminalFileReference };

const PLAIN_FILE_REFERENCE =
  /(?:file:\/\/\/[^\s"'`<>|()[\]{},;!?，。；！？、：‘’“”《》〈〉【】「」『』]+|[A-Za-z]:[\\/][^\s"'`<>|()[\]{},;!?，。；！？、：‘’“”《》〈〉【】「」『』]+|(?:\.{0,2}[\\/])?(?:[\p{L}\p{N}_.@+\-]+[\\/])+[\p{L}\p{N}_.@+\-]+(?::\d+(?::\d+)?)?|[\p{L}\p{N}_.@+\-]+\.[\p{L}\p{N}_-]{1,16}:\d+(?::\d+)?)/gu;
const WRAPPED_FILE_REFERENCE = /([`'"])([^`'"\r\n]+)\1(?::\d+(?::\d+)?)?/gu;

export function findTerminalFileReferences(
  text: string,
  platform: TerminalPathPlatform = detectTerminalPathPlatform(),
): TerminalFileReference[] {
  const references: TerminalFileReference[] = [];

  for (const match of text.matchAll(WRAPPED_FILE_REFERENCE)) {
    const wrapper = match[1] ?? "";
    const inner = match[2] ?? "";
    const full = match[0];
    const suffix = full.slice(wrapper.length + inner.length + wrapper.length);
    if (!looksLikeFilePath(inner, suffix.length > 0, platform)) continue;
    const parsed = parseFileReference(
      `${inner}${suffix}`,
      match.index,
      match.index + full.length,
      full,
      platform,
    );
    if (parsed) references.push(parsed);
  }

  for (const match of text.matchAll(PLAIN_FILE_REFERENCE)) {
    const startIndex = match.index;
    const raw = match[0];
    const endIndex = startIndex + raw.length;
    if (!hasFileReferenceStartBoundary(text, startIndex)) continue;
    if (
      references.some(
        (reference) =>
          startIndex >= reference.startIndex && endIndex <= reference.endIndex,
      )
    ) {
      continue;
    }
    const parsed = parseFileReference(raw, startIndex, endIndex, raw, platform);
    if (parsed) references.push(parsed);
  }

  return references.sort((left, right) => left.startIndex - right.startIndex);
}

export function classifyTerminalUri(
  uri: string,
  platform: TerminalPathPlatform = detectTerminalPathPlatform(),
): TerminalLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (["http:", "https:", "ftp:", "about:"].includes(parsed.protocol)) {
    return { kind: "web", url: parsed.href };
  }
  if (parsed.protocol !== "file:") return null;

  let path = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  if (!hasPlatformCompatibleFileNames(path, platform)) return null;
  const location = parseHashLocation(parsed.hash);
  return {
    kind: "file",
    reference: {
      path,
      line: location.line,
      column: location.column,
      text: uri,
      startIndex: 0,
      endIndex: uri.length,
    },
  };
}

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: TerminalBufferSource,
    private readonly activateReference: (
      reference: TerminalFileReference,
    ) => void,
  ) {}

  provideLinks(
    y: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const extracted = extractWrappedLine(this.terminal.buffer.active, y);
    if (!extracted) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];
    for (const reference of findTerminalFileReferences(extracted.text)) {
      const start = extracted.positions[reference.startIndex];
      const end =
        extracted.positions[
          Math.max(reference.startIndex, reference.endIndex - 1)
        ];
      if (!start || !end) continue;
      links.push({
        text: reference.text,
        range: {
          start,
          end,
        },
        activate: () => this.activateReference(reference),
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}

interface TerminalBufferSource {
  buffer: {
    active: WrappedLineBuffer;
  };
}

function parseFileReference(
  rawValue: string,
  startIndex: number,
  originalEndIndex: number,
  originalText: string,
  platform: TerminalPathPlatform,
): TerminalFileReference | null {
  const trimmed = rawValue.replace(/[.,;!?]+$/u, "");
  const removed = rawValue.length - trimmed.length;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) {
    if (!trimmed.toLowerCase().startsWith("file:///")) return null;
    const target = classifyTerminalUri(trimmed, platform);
    if (!target || target.kind !== "file") return null;
    return {
      ...target.reference,
      text: originalText.slice(0, originalText.length - removed),
      startIndex,
      endIndex: originalEndIndex - removed,
    };
  }

  const location = parseTrailingLocation(trimmed);
  const path = location.path;
  if (
    !looksLikeFilePath(path, location.line !== null, platform) ||
    !hasPlatformCompatibleFileNames(path, platform)
  ) {
    return null;
  }
  return {
    path,
    line: location.line,
    column: location.column,
    text: originalText.slice(0, originalText.length - removed),
    startIndex,
    endIndex: originalEndIndex - removed,
  };
}

function parseTrailingLocation(value: string): {
  path: string;
  line: number | null;
  column: number | null;
} {
  const hash = value.match(/^(.*)#L(\d+)(?:(?::?C)(\d+))?$/iu);
  if (hash) {
    return {
      path: hash[1] ?? "",
      line: positiveInteger(hash[2]),
      column: positiveInteger(hash[3]),
    };
  }
  const parenthesized = value.match(/^(.*)\((\d+)(?:,(\d+))?\)$/u);
  if (parenthesized) {
    return {
      path: parenthesized[1] ?? "",
      line: positiveInteger(parenthesized[2]),
      column: positiveInteger(parenthesized[3]),
    };
  }
  const colon = value.match(/^(.*?):(\d+)(?::(\d+))?$/u);
  if (colon) {
    return {
      path: colon[1] ?? "",
      line: positiveInteger(colon[2]),
      column: positiveInteger(colon[3]),
    };
  }
  return { path: value, line: null, column: null };
}

function parseHashLocation(hash: string): {
  line: number | null;
  column: number | null;
} {
  const match = hash.match(/^#L(\d+)(?:(?::?C)(\d+))?$/iu);
  return {
    line: positiveInteger(match?.[1]),
    column: positiveInteger(match?.[2]),
  };
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function looksLikeFilePath(
  path: string,
  hasLocation: boolean,
  platform: TerminalPathPlatform,
): boolean {
  if (!path || path.includes("://")) return false;
  if (path.includes("/") || (platform === "windows" && path.includes("\\"))) {
    return true;
  }
  return (
    hasLocation && /^[\p{L}\p{N}_.@+\-]+\.[\p{L}\p{N}_-]{1,16}$/u.test(path)
  );
}

function hasFileReferenceStartBoundary(
  text: string,
  startIndex: number,
): boolean {
  if (startIndex === 0) return true;
  return !/[\\/\p{L}\p{N}_.@+-]/u.test(text[startIndex - 1] ?? "");
}

function hasPlatformCompatibleFileNames(
  path: string,
  platform: TerminalPathPlatform,
): boolean {
  const pathWithoutDrive =
    platform === "windows" ? path.replace(/^[A-Za-z]:/u, "") : path;
  const segments = pathWithoutDrive.split(
    platform === "windows" ? /[\\/]/u : /\//u,
  );

  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") continue;
    if (platform === "windows") {
      if (/[\u0000-\u001f<>:"|?*]/u.test(segment)) return false;
      if (/[ .]$/u.test(segment)) return false;
      continue;
    }
    if (segment.includes("\0")) return false;
  }
  return true;
}

export function detectTerminalPathPlatform(
  reportedPlatform = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform} ${navigator.userAgent}`,
): TerminalPathPlatform {
  if (/windows|win32|win64/iu.test(reportedPlatform)) return "windows";
  if (/mac|iphone|ipad/iu.test(reportedPlatform)) return "macos";
  return "linux";
}
