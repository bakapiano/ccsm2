export type UiIconName =
  | "arrow-right"
  | "board"
  | "browser"
  | "ellipsis"
  | "files"
  | "find"
  | "git"
  | "goto-line"
  | "open-external"
  | "play"
  | "refresh"
  | "replace"
  | "save"
  | "shell"
  | "stop"
  | "wrap";

const UI_ICONS: Record<UiIconName, string> = {
  "arrow-right": icon(`<path d="M3 8h9"></path><path d="m9 4 4 4-4 4"></path>`),
  board: icon(
    `<rect x="2" y="2.5" width="12" height="10.5" rx="1"></rect><path d="M5 10V7m3 3V5m3 5V8"></path>`,
  ),
  browser: icon(
    `<circle cx="8" cy="8" r="5.5"></circle><path d="M2.5 8h11M8 2.5c1.7 1.5 2.6 3.3 2.6 5.5S9.7 12 8 13.5C6.3 12 5.4 10.2 5.4 8S6.3 4 8 2.5Z"></path>`,
  ),
  ellipsis: icon(
    `<circle cx="3.5" cy="8" r=".75" fill="currentColor" stroke="none"></circle><circle cx="8" cy="8" r=".75" fill="currentColor" stroke="none"></circle><circle cx="12.5" cy="8" r=".75" fill="currentColor" stroke="none"></circle>`,
  ),
  files: icon(`<path d="M1.75 4.5h4.8L8 6h6.25v6.5H1.75z"></path>`),
  find: icon(
    `<circle cx="7" cy="7" r="4"></circle><path d="m10 10 3.25 3.25"></path>`,
  ),
  git: icon(
    `<circle cx="4" cy="3.5" r="1.5"></circle><circle cx="4" cy="12.5" r="1.5"></circle><circle cx="12" cy="5.5" r="1.5"></circle><path d="M4 5v6M5.5 11.5h1A5.5 5.5 0 0 0 12 7V7"></path>`,
  ),
  "goto-line": icon(
    `<path d="M2.5 4h7M2.5 8h5M2.5 12h7"></path><path d="m10 9 3 3-3 3"></path>`,
  ),
  "open-external": icon(
    `<path d="M9 2.5h4.5V7"></path><path d="m13.25 2.75-6 6"></path><path d="M7 4H3v9h9V9"></path>`,
  ),
  play: icon(`<path d="m5 3.5 7 4.5-7 4.5z"></path>`),
  refresh: icon(
    `<path d="M12.5 5.5V2.75L10.8 4.1A5.25 5.25 0 1 0 13 9"></path>`,
  ),
  replace: icon(
    `<path d="M3 5h8.5"></path><path d="m9.5 3 2 2-2 2M13 11H4.5"></path><path d="m6.5 9-2 2 2 2"></path>`,
  ),
  save: icon(
    `<path d="M2.5 2.5h8l3 3v8h-11z"></path><path d="M5 2.5v4h5v-4M5 10h6v3.5"></path>`,
  ),
  shell: icon(`<path d="m2.5 4 3.5 4-3.5 4M7.5 12h6"></path>`),
  stop: icon(`<rect x="4" y="4" width="8" height="8" rx="1"></rect>`),
  wrap: icon(
    `<path d="M2.5 4.5h8M2.5 8h9a2 2 0 0 1 0 4H8"></path><path d="m9.5 9.5-2.5 2.5 2.5 2.5M2.5 11.5h2"></path>`,
  ),
};

export function uiIcon(name: UiIconName): string {
  return UI_ICONS[name];
}

function icon(content: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${content}</svg>`;
}
