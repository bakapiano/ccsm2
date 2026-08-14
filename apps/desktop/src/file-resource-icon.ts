export type FileResourceKind = "directory" | "file" | "other" | "symlink";

export type FileResourceIconKind =
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

export function fileResourceIconKind(
  path: string,
  kind: FileResourceKind = "file",
  expanded = false,
): FileResourceIconKind {
  if (kind === "directory") return expanded ? "folder-open" : "folder";
  if (kind === "symlink") return "symlink";
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").at(-1)?.toLowerCase() ?? normalized;
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

export function createFileResourceIcon(
  path: string,
  kind: FileResourceKind = "file",
  expanded = false,
): HTMLSpanElement {
  const iconKind = fileResourceIconKind(path, kind, expanded);
  const icon = document.createElement("span");
  icon.className = "file-resource-icon";
  icon.dataset.icon = iconKind;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = FILE_RESOURCE_ICONS[iconKind];
  return icon;
}

const FILE_RESOURCE_ICONS: Record<FileResourceIconKind, string> = {
  folder: `<svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.5 1.5h6.5v6.5h-13z"></path></svg>`,
  "folder-open": `<svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.5 1.5h6.5l-1.4 6.5H2.4z"></path><path d="M1.5 6V4.5h5L8 6"></path></svg>`,
  document: `<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z"></path><path d="M9.5 1.5v3h3"></path></svg>`,
  code: `<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z"></path><path d="m7 7-2 2 2 2m2-4 2 2-2 2"></path></svg>`,
  json: `<svg viewBox="0 0 16 16"><path d="M6 2.5H4.5v4L3 8l1.5 1.5v4H6m4-11h1.5v4L13 8l-1.5 1.5v4H10"></path></svg>`,
  markdown: `<svg viewBox="0 0 16 16"><path d="M1.5 3.5h13v9h-13z"></path><path d="M3.5 10V6l2 2 2-2v4m2-2 1.5 2 1.5-2"></path></svg>`,
  config: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2"></circle><path d="M8 1.5v2m0 9v2m6.5-6.5h-2m-9 0h-2m11-4.5-1.4 1.4m-6.2 6.2-1.4 1.4m9 0-1.4-1.4M4.9 4.9 3.5 3.5"></path></svg>`,
  image: `<svg viewBox="0 0 16 16"><path d="M2 2.5h12v11H2z"></path><circle cx="5" cy="5.5" r="1"></circle><path d="m3.5 12 3-3 2 2 1.5-1.5L12.5 12"></path></svg>`,
  archive: `<svg viewBox="0 0 16 16"><path d="M3 1.5h10v13H3z"></path><path d="M7 2h2v2H7zm0 4h2v2H7zm0 4h2v2H7z"></path></svg>`,
  symlink: `<svg viewBox="0 0 16 16"><path d="M6.5 5.5 5 4a2.1 2.1 0 0 0-3 3l2 2a2.1 2.1 0 0 0 3 0l.5-.5m1-1L9 7a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1-3 3l-1.5-1.5"></path></svg>`,
};
