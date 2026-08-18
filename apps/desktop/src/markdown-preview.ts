import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
});

const allowedLinkProtocols = new Set(["http", "https", "mailto"]);

markdown.validateLink = (url) => {
  const normalized = url
    .trim()
    .replace(/[\u0000-\u0020\u007f]/g, "")
    .toLowerCase();
  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) {
    return false;
  }
  const protocol = /^([a-z][a-z\d+.-]*):/.exec(normalized)?.[1];
  return protocol === undefined || allowedLinkProtocols.has(protocol);
};

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index]?.content.trim() || "image";
  const escapedAlt = markdown.utils.escapeHtml(alt);
  return `<span class="markdown-preview-image-placeholder" role="img" aria-label="${escapedAlt}">[Image: ${escapedAlt}]</span>`;
};

export function renderMarkdownPreview(source: string): HTMLElement {
  const preview = document.createElement("article");
  preview.className = "markdown-preview-content";
  preview.innerHTML = markdown.render(source);

  for (const link of preview.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  return preview;
}
