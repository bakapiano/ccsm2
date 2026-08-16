import Vditor from "vditor";
import "vditor/dist/index.css";

import type { ThemeMode } from "./theme";
import { uiIcon } from "./ui-icons";

export interface VditorEditorOptions {
  value: string;
  ariaLabel: string;
  theme: ThemeMode;
  editable: boolean;
  canSave: boolean;
  onInput(value: string): void;
  onSave(): void;
  onScroll(scrollTop: number): void;
}

export class VditorEditor {
  readonly #scrollElement: HTMLPreElement;
  readonly #saveButton: HTMLButtonElement;

  private constructor(
    private readonly editor: Vditor,
    private readonly assetBase: string,
    private readonly options: VditorEditorOptions,
    scrollElement: HTMLPreElement,
    saveButton: HTMLButtonElement,
  ) {
    this.#scrollElement = scrollElement;
    this.#saveButton = saveButton;
    this.#scrollElement.addEventListener("scroll", this.#onScroll, {
      passive: true,
    });
    this.#saveButton.addEventListener("click", this.#onSave);
  }

  static async create(
    host: HTMLElement,
    options: VditorEditorOptions,
  ): Promise<VditorEditor> {
    const assetBase = vditorAssetBase();
    let ready!: () => void;
    const initialized = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const editor = new Vditor(host, {
      value: options.value,
      mode: "ir",
      lang: "en_US",
      cdn: assetBase,
      width: "100%",
      height: "100%",
      minHeight: 0,
      theme: editorTheme(options.theme),
      icon: "ant",
      cache: { enable: false },
      tab: "  ",
      fullscreen: { index: 5000 },
      toolbarConfig: { hide: false, pin: true },
      toolbar: [
        "headings",
        "bold",
        "italic",
        "strike",
        "link",
        "|",
        "list",
        "ordered-list",
        "check",
        "outdent",
        "indent",
        "|",
        "quote",
        "line",
        "code",
        "inline-code",
        "table",
        "|",
        "undo",
        "redo",
        "|",
        "fullscreen",
      ],
      link: { isOpen: false },
      image: { isPreview: false },
      preview: {
        delay: 100,
        actions: [],
        hljs: {
          enable: true,
          lineNumber: true,
          style: codeTheme(options.theme),
        },
        math: {
          engine: "KaTeX",
          inlineDigit: true,
        },
        markdown: {
          codeBlockPreview: true,
          footnotes: true,
          gfmAutoLink: true,
          mark: true,
          mathBlockPreview: true,
          sanitize: true,
          toc: true,
        },
        theme: {
          current: contentTheme(options.theme),
          path: `${assetBase}/dist/css/content-theme`,
        },
      },
      input: options.onInput,
      keydown: (event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          options.onSave();
        }
      },
      after: ready,
    });

    try {
      await withTimeout(initialized, 15_000, "Vditor initialization timed out");
      const scrollElement = host.querySelector<HTMLPreElement>(
        ".vditor-ir > .vditor-reset",
      );
      if (!scrollElement) throw new Error("Vditor IR surface was not created");
      const toolbar = host.querySelector<HTMLElement>(".vditor-toolbar");
      if (!toolbar) throw new Error("Vditor toolbar was not created");
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className =
        "file-editor-vditor-save control-button control-button-icon";
      saveButton.title = "Save (Ctrl+S)";
      saveButton.setAttribute("aria-label", "Save");
      saveButton.setAttribute("aria-keyshortcuts", "Control+S Meta+S");
      saveButton.innerHTML = uiIcon("save");
      saveButton.disabled = !options.canSave;
      toolbar.prepend(saveButton);
      const result = new VditorEditor(
        editor,
        assetBase,
        options,
        scrollElement,
        saveButton,
      );
      scrollElement.setAttribute("aria-label", options.ariaLabel);
      scrollElement.setAttribute("aria-multiline", "true");
      scrollElement.setAttribute("role", "textbox");
      result.setTheme(options.theme);
      result.setEditable(options.editable);
      return result;
    } catch (error) {
      editor.destroy();
      throw error;
    }
  }

  getValue(): string {
    return this.editor.getValue();
  }

  setValue(value: string, clearStack = true): void {
    this.editor.setValue(value, clearStack);
  }

  appendText(text: string): void {
    const value = `${this.getValue()}${text}`;
    this.editor.setValue(value);
    this.options.onInput(value);
  }

  focus(): void {
    this.editor.focus();
  }

  setEditable(editable: boolean): void {
    if (editable) this.editor.enable();
    else this.editor.disabled();
  }

  setSaveEnabled(enabled: boolean): void {
    this.#saveButton.disabled = !enabled;
  }

  setTheme(theme: ThemeMode): void {
    this.editor.setTheme(
      editorTheme(theme),
      contentTheme(theme),
      codeTheme(theme),
      `${this.assetBase}/dist/css/content-theme`,
    );
  }

  get scrollTop(): number {
    return this.#scrollElement.scrollTop;
  }

  set scrollTop(value: number) {
    this.#scrollElement.scrollTop = value;
  }

  destroy(): void {
    this.#scrollElement.removeEventListener("scroll", this.#onScroll);
    this.#saveButton.removeEventListener("click", this.#onSave);
    this.editor.destroy();
  }

  readonly #onSave = (): void => {
    this.options.onSave();
  };

  readonly #onScroll = (): void => {
    this.options.onScroll(this.#scrollElement.scrollTop);
  };
}

export function vditorAssetBase(base = document.baseURI): string {
  return new URL("vendor/vditor", base).href.replace(/\/$/, "");
}

function editorTheme(theme: ThemeMode): "classic" | "dark" {
  return theme === "dark" ? "dark" : "classic";
}

function contentTheme(theme: ThemeMode): "light" | "dark" {
  return theme;
}

function codeTheme(theme: ThemeMode): "github" | "github-dark" {
  return theme === "dark" ? "github-dark" : "github";
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(message)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
