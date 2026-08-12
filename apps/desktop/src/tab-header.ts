import type { ITabRenderer, TabPartInitParameters } from "dockview";

import type { CliSessionDto } from "./generated/CliSessionDto";
import type { TabDto } from "./generated/TabDto";

export type TabIconKind =
  | "browser"
  | "claude"
  | "codex"
  | "copilot"
  | "document"
  | "files"
  | "git"
  | "shell";

const ICONS: Record<
  Exclude<TabIconKind, "claude" | "codex" | "copilot">,
  string
> = {
  browser: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"></path>
    </svg>`,
  document: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z"></path>
      <path d="M14 3v5h5"></path>
      <line x1="9" y1="12" x2="15" y2="12"></line>
      <line x1="9" y1="16" x2="15" y2="16"></line>
    </svg>`,
  files: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
    </svg>`,
  git: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15"></line>
      <circle cx="18" cy="6" r="3"></circle>
      <circle cx="6" cy="18" r="3"></circle>
      <path d="M18 9a9 9 0 0 1-9 9"></path>
    </svg>`,
  shell: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>`,
};

const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;

export function resolveTabIconKind(
  tab: TabDto,
  cliSessions: readonly CliSessionDto[],
): TabIconKind {
  switch (tab.kind) {
    case "browser":
      return "browser";
    case "file-explorer":
      return "files";
    case "file-editor":
      return "document";
    case "git":
      return "git";
    case "cli-session": {
      const provider = cliSessions.find(
        (session) => session.id === tab.resourceId,
      )?.provider;
      if (provider) return provider;
      const title = tab.title.toLowerCase();
      if (title.includes("claude")) return "claude";
      if (title.includes("codex")) return "codex";
      if (title.includes("copilot")) return "copilot";
      return "shell";
    }
  }
}

export class CcsmTabRenderer implements ITabRenderer {
  readonly element = document.createElement("div");
  readonly #label = document.createElement("span");
  readonly #close = document.createElement("button");
  readonly #tooltip: string | null;
  readonly #requestClose: () => void;
  #titleSubscription: { dispose(): void } | null = null;

  constructor(
    tab: TabDto,
    cliSessions: readonly CliSessionDto[],
    requestClose: (tabId: string) => void,
  ) {
    this.element.className = "ccsm-tab";
    this.element.dataset.tabKind = tab.kind;
    this.#tooltip =
      tab.kind === "file-editor" &&
      tab.state &&
      typeof tab.state === "object" &&
      "relativePath" in tab.state &&
      typeof (tab.state as { relativePath?: unknown }).relativePath === "string"
        ? (tab.state as { relativePath: string }).relativePath
        : null;
    this.#requestClose = () => requestClose(tab.id);

    const iconKind = resolveTabIconKind(tab, cliSessions);
    const icon = document.createElement("span");
    icon.className = "ccsm-tab-icon";
    icon.dataset.icon = iconKind;
    icon.setAttribute("aria-hidden", "true");
    if (
      iconKind === "claude" ||
      iconKind === "codex" ||
      iconKind === "copilot"
    ) {
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      image.src = `/assets/${iconKind}-color.svg`;
      icon.append(image);
    } else {
      icon.innerHTML = ICONS[iconKind];
    }

    this.#label.className = "ccsm-tab-label";
    this.#close.className = "ccsm-tab-close";
    this.#close.type = "button";
    this.#close.title = "Close tab";
    this.#close.innerHTML = CLOSE_ICON;
    this.element.append(icon, this.#label, this.#close);
  }

  init(parameters: TabPartInitParameters): void {
    this.#renderTitle(parameters.title);
    this.#titleSubscription = parameters.api.onDidTitleChange(({ title }) =>
      this.#renderTitle(title),
    );
    this.#close.addEventListener("pointerdown", stopCloseEvent);
    this.#close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#requestClose();
    });
  }

  dispose(): void {
    this.#titleSubscription?.dispose();
    this.#titleSubscription = null;
  }

  #renderTitle(title: string): void {
    this.#label.textContent = title;
    this.element.title = this.#tooltip ?? title;
    this.#close.setAttribute("aria-label", `Close ${title}`);
  }
}

function stopCloseEvent(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
