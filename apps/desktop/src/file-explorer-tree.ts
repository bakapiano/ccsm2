import type { FileEntryDto } from "./generated/FileEntryDto";

export type FileExplorerIconKind =
  | "archive"
  | "code"
  | "config"
  | "document"
  | "folder"
  | "folder-open"
  | "image"
  | "json"
  | "markdown"
  | "symlink";

export interface VisibleFileRow {
  entry: FileEntryDto;
  depth: number;
  parentPath: string;
  expanded: boolean;
}

export type FileTreeKeyboardResult =
  | { action: "collapse" | "expand" | "open"; path: string }
  | { action: "focus"; path: string }
  | null;

export function flattenFileTree(
  rootPath: string,
  entriesByDirectory: ReadonlyMap<string, readonly FileEntryDto[]>,
  expandedPaths: readonly string[],
): VisibleFileRow[] {
  const expanded = new Set(expandedPaths);
  const result: VisibleFileRow[] = [];
  const append = (parentPath: string, depth: number) => {
    for (const entry of entriesByDirectory.get(parentPath) ?? []) {
      const isExpanded =
        entry.kind === "directory" && expanded.has(entry.relativePath);
      result.push({ entry, depth, parentPath, expanded: isExpanded });
      if (isExpanded) append(entry.relativePath, depth + 1);
    }
  };
  append(rootPath, 0);
  return result;
}

export function fileExplorerIconKind(
  entry: FileEntryDto,
  expanded: boolean,
): FileExplorerIconKind {
  if (entry.kind === "directory") return expanded ? "folder-open" : "folder";
  if (entry.kind === "symlink") return "symlink";
  const name = entry.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : "";
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "rs",
      "py",
      "go",
      "java",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "cs",
      "swift",
      "kt",
      "kts",
    ].includes(extension ?? "")
  )
    return "code";
  if (extension === "json" || name.endsWith(".code-workspace")) return "json";
  if (["md", "mdx", "rst"].includes(extension ?? "")) return "markdown";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(
      extension ?? "",
    )
  )
    return "image";
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(extension ?? ""))
    return "archive";
  if (
    ["yaml", "yml", "toml", "ini", "env", "lock"].includes(extension ?? "") ||
    [".gitignore", ".gitattributes", "dockerfile", "makefile"].includes(name)
  )
    return "config";
  return "document";
}

export function fileTreeKeyboardAction(
  rows: readonly VisibleFileRow[],
  currentPath: string | null,
  key:
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight"
    | "ArrowUp"
    | "End"
    | "Enter"
    | "Home",
): FileTreeKeyboardResult {
  if (rows.length === 0) return null;
  const currentIndex = Math.max(
    0,
    rows.findIndex((row) => row.entry.relativePath === currentPath),
  );
  const current = rows[currentIndex] ?? rows[0];
  if (!current) return null;
  if (key === "ArrowDown")
    return focus(rows[Math.min(rows.length - 1, currentIndex + 1)]);
  if (key === "ArrowUp") return focus(rows[Math.max(0, currentIndex - 1)]);
  if (key === "Home") return focus(rows[0]);
  if (key === "End") return focus(rows.at(-1));
  if (key === "Enter")
    return {
      action:
        current.entry.kind === "directory"
          ? current.expanded
            ? "collapse"
            : "expand"
          : "open",
      path: current.entry.relativePath,
    };
  if (key === "ArrowRight") {
    if (current.entry.kind !== "directory") return null;
    if (!current.expanded)
      return { action: "expand", path: current.entry.relativePath };
    return focus(
      rows.find(
        (row, index) =>
          index > currentIndex && row.parentPath === current.entry.relativePath,
      ),
    );
  }
  if (current.entry.kind === "directory" && current.expanded)
    return { action: "collapse", path: current.entry.relativePath };
  return focus(
    rows.find((row) => row.entry.relativePath === current.parentPath),
  );
}

function focus(row: VisibleFileRow | undefined): FileTreeKeyboardResult {
  return row ? { action: "focus", path: row.entry.relativePath } : null;
}
