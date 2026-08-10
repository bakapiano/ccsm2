import type { FileChangeHintDto } from "./generated/FileChangeHintDto";
import type { TabDto } from "./generated/TabDto";

export interface FileEditorTabState {
  relativePath: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop: number;
  wordWrap: boolean;
}

export type EditorLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "text"
  | "yaml";

const KEYWORDS = new Set(
  [
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "crate",
    "def",
    "default",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "fn",
    "for",
    "from",
    "function",
    "if",
    "impl",
    "import",
    "in",
    "interface",
    "let",
    "loop",
    "match",
    "mod",
    "mut",
    "new",
    "null",
    "pub",
    "return",
    "self",
    "static",
    "struct",
    "super",
    "switch",
    "this",
    "throw",
    "trait",
    "true",
    "try",
    "type",
    "undefined",
    "use",
    "var",
    "while",
    "with",
    "yield",
  ].map((value) => value.toLowerCase()),
);

const TOKEN_PATTERN =
  /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b/gi;

export function parseFileEditorState(tab: TabDto): FileEditorTabState {
  const value =
    tab.state && typeof tab.state === "object"
      ? (tab.state as Partial<FileEditorTabState>)
      : {};
  return {
    relativePath: normalizeRelativePath(
      typeof value.relativePath === "string"
        ? value.relativePath
        : (tab.resourceId ?? ""),
    ),
    selectionAnchor: finiteNonNegative(value.selectionAnchor),
    selectionHead: finiteNonNegative(value.selectionHead),
    scrollTop: finiteNonNegative(value.scrollTop),
    wordWrap: value.wordWrap === true,
  };
}

export function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function fileName(path: string): string {
  return normalizeRelativePath(path).split("/").at(-1) || "Untitled";
}

export function distinctFileEditorTitles(
  tabs: readonly { id: string; path: string; dirty?: boolean }[],
): Map<string, string> {
  const result = new Map<string, string>();
  const groups = new Map<string, Array<(typeof tabs)[number]>>();
  for (const tab of tabs) {
    const key = fileName(tab.path).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }
  for (const group of groups.values()) {
    const name = fileName(group[0]?.path ?? "");
    if (group.length === 1) {
      const tab = group[0];
      if (tab) result.set(tab.id, withDirtyMarker(name, tab.dirty));
      continue;
    }
    const parents = group.map((tab) => {
      const parts = normalizeRelativePath(tab.path).split("/");
      parts.pop();
      return parts;
    });
    let depth = 1;
    const maxDepth = Math.max(1, ...parents.map((parts) => parts.length));
    for (; depth < maxDepth; depth += 1) {
      const labels = parents.map((parts) => parentSuffix(parts, depth));
      if (
        new Set(labels.map((label) => label.toLowerCase())).size ===
        group.length
      )
        break;
    }
    group.forEach((tab, index) => {
      const parent = parentSuffix(parents[index] ?? [], depth);
      result.set(tab.id, withDirtyMarker(`${name} — ${parent}`, tab.dirty));
    });
  }
  return result;
}

export function languageForPath(path: string): EditorLanguage {
  const name = fileName(path).toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : "";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(extension ?? ""))
    return "javascript";
  if (extension === "json" || name.endsWith(".code-workspace")) return "json";
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(extension ?? ""))
    return "html";
  if (["css", "scss", "less"].includes(extension ?? "")) return "css";
  if (["md", "mdx"].includes(extension ?? "")) return "markdown";
  if (extension === "py") return "python";
  if (extension === "rs") return "rust";
  if (
    ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(extension ?? "")
  )
    return "shell";
  if (extension === "sql") return "sql";
  if (["yaml", "yml", "toml"].includes(extension ?? "")) return "yaml";
  return "text";
}

export function fileChangeAffectsPath(
  hint: FileChangeHintDto,
  relativePath: string,
): boolean {
  if (hint.overflow) return true;
  const target = normalizeRelativePath(relativePath).toLowerCase();
  return hint.relativePaths.some(
    (path) => normalizeRelativePath(path).toLowerCase() === target,
  );
}

export function lineAndColumn(
  content: string,
  position: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, content.length));
  let line = 1;
  let lineStart = -1;
  for (let index = 0; index < clamped; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index;
    }
  }
  return { line, column: clamped - lineStart };
}

export function findBracketMatch(
  content: string,
  caret: number,
): readonly [number, number] | null {
  const candidates = [caret, caret - 1].filter(
    (value) => value >= 0 && value < content.length,
  );
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    ")": "(",
    "]": "[",
    "}": "{",
  };
  for (const index of candidates) {
    const bracket = content[index];
    const match = bracket ? pairs[bracket] : undefined;
    if (!bracket || !match) continue;
    const forward = "([{".includes(bracket);
    let depth = 0;
    for (
      let cursor = index;
      cursor >= 0 && cursor < content.length;
      cursor += forward ? 1 : -1
    ) {
      const character = content[cursor];
      if (character === bracket) depth += 1;
      if (character === match) depth -= 1;
      if (depth === 0) return [index, cursor];
    }
  }
  return null;
}

export function highlightSource(
  content: string,
  language: EditorLanguage,
  brackets: readonly [number, number] | null,
): string {
  const ranges: Array<{ from: number; to: number; kind: string }> = [];
  if (language !== "text") {
    TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_PATTERN.exec(content))) {
      const token = match[0];
      let kind = "identifier";
      if (
        token.startsWith("//") ||
        token.startsWith("/*") ||
        token.startsWith("<!--") ||
        (token.startsWith("#") && language !== "markdown")
      ) {
        kind = "comment";
      } else if (/^["'`]/.test(token)) {
        kind = "string";
      } else if (/^(?:0x[\da-f]+|\d)/i.test(token)) {
        kind = "number";
      } else if (KEYWORDS.has(token.toLowerCase())) {
        kind = "keyword";
      }
      ranges.push({ from: match.index, to: match.index + token.length, kind });
      if (match[0].length === 0) TOKEN_PATTERN.lastIndex += 1;
    }
  }
  const bracketSet = new Set(brackets ?? []);
  let rangeIndex = 0;
  let active = ranges[rangeIndex];
  let openKind: string | null = null;
  let output = "";
  for (let index = 0; index < content.length; index += 1) {
    while (active && index >= active.to) {
      if (openKind) output += "</span>";
      openKind = null;
      active = ranges[++rangeIndex];
    }
    if (active && index === active.from) {
      output += `<span class="syntax-${active.kind}">`;
      openKind = active.kind;
    }
    const value = escapeHtml(content[index] ?? "");
    output += bracketSet.has(index)
      ? `<mark class="syntax-bracket">${value}</mark>`
      : value;
  }
  if (openKind) output += "</span>";
  return output.endsWith("\n") ? `${output} ` : output;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function parentSuffix(parts: readonly string[], depth: number): string {
  return parts.length === 0 ? "." : parts.slice(-depth).join("/");
}

function withDirtyMarker(title: string, dirty = false): string {
  return dirty ? `${title} ●` : title;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
