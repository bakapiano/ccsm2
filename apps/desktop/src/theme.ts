import type { ITheme } from "../vendor/ghostty-web/lib/interfaces";

export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "ccsm.theme";

export const TERMINAL_THEMES: Record<ThemeMode, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#333333",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    selectionForeground: "#000000",
    black: "#000000",
    red: "#cd3131",
    green: "#107c10",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
  dark: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    selectionForeground: "#ffffff",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
};

// Codex derives its composer surface once from the OSC 11 startup response:
// 12% white over a dark background and 4% black over a light background.
// Its terminal palette is process-cached, so live CCSM theme changes remap
// both possible buffer values to the active presentation color.
export const CODEX_TERMINAL_BUFFER_COLOR_REMAP: Record<
  ThemeMode,
  Readonly<Record<string, string>>
> = {
  light: {
    "#393939": "#f4f4f4",
    "#f4f4f4": "#f4f4f4",
  },
  dark: {
    "#393939": "#393939",
    "#f4f4f4": "#393939",
  },
};

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function storedTheme(value: string | null): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: ThemeMode): ThemeMode {
  return theme === "light" ? "dark" : "light";
}

export function applyDocumentTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#191b1b" : "#f6f8fa");
}

export class ThemeController {
  readonly #listeners = new Set<(theme: ThemeMode) => void>();
  #theme: ThemeMode;

  constructor(
    private readonly storage: ThemeStorage,
    private readonly apply: (theme: ThemeMode) => void,
  ) {
    this.#theme = storedTheme(storage.getItem(THEME_STORAGE_KEY));
    this.apply(this.#theme);
  }

  get current(): ThemeMode {
    return this.#theme;
  }

  set(theme: ThemeMode): ThemeMode {
    if (theme === this.#theme) return this.#theme;
    this.#theme = theme;
    this.storage.setItem(THEME_STORAGE_KEY, this.#theme);
    this.apply(this.#theme);
    for (const listener of this.#listeners) listener(this.#theme);
    return this.#theme;
  }

  toggle(): ThemeMode {
    return this.set(nextTheme(this.#theme));
  }

  subscribe(listener: (theme: ThemeMode) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
