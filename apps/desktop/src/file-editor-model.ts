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

export type FileEditorEngine = "codemirror6" | "vditor-ir";

export function editorEngineForPath(path: string): FileEditorEngine {
  const name = fileName(path).toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : "";
  return extension === "md" || extension === "markdown"
    ? "vditor-ir"
    : "codemirror6";
}

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
      ) {
        break;
      }
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
  if (["md", "markdown", "mdx"].includes(extension ?? "")) return "markdown";
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
