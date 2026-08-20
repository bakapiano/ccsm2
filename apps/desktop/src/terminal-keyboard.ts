import type { ProviderKind } from "./generated/ProviderKind";

type ModifierKeyEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

interface CliInputTerminal {
  hasSelection(): boolean;
  onKey(listener: (event: { domEvent: KeyboardEvent }) => void): {
    dispose(): void;
  };
  scrollToBottom(): void;
}

interface CliCopyTarget {
  getSelection(): string;
}

interface CliFocusTarget {
  hasFocus(): boolean;
  canRestoreFocus(): boolean;
  restoreFocus(): void;
}

type WindowFocusSubscriber = (
  listener: (focused: boolean) => void,
) => Promise<() => void>;

const MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/**
 * Translate host chords whose standalone-terminal compatibility encoding is
 * different from the browser terminal's lossless modified-key encoding.
 */
export function cliShortcutInput(
  provider: ProviderKind | null,
  event: ModifierKeyEvent,
): string | null {
  if (
    provider === "codex" &&
    event.code === "Enter" &&
    !event.altKey &&
    !event.metaKey &&
    ((event.ctrlKey && !event.shiftKey) || (event.shiftKey && !event.ctrlKey))
  ) {
    // Codex accepts legacy Alt+Enter as multiline input through ConPTY. Keep
    // this as ESC + CR: CSI-u is not negotiated on the live input path and its
    // printable suffix would otherwise be inserted into the prompt.
    return "\x1b\r";
  }

  return null;
}

export function isCliCopyShortcut(event: ModifierKeyEvent): boolean {
  return (
    event.code === "KeyC" && (event.ctrlKey || event.metaKey) && !event.altKey
  );
}

export function cliCopyShortcutText(
  terminal: CliCopyTarget,
  event: ModifierKeyEvent,
): string | null {
  if (!isCliCopyShortcut(event)) return null;
  return terminal.getSelection() || null;
}

export function isCliPasteShortcut(event: ModifierKeyEvent): boolean {
  return (
    event.code === "KeyV" && (event.ctrlKey || event.metaKey) && !event.altKey
  );
}

export function installCliInputFollow(
  terminal: CliInputTerminal,
  host: EventTarget,
  getProvider: () => ProviderKind | null,
): () => void {
  const followInput = (): void => {
    const provider = getProvider();
    if (provider === "claude" || provider === "codex") {
      terminal.scrollToBottom();
    }
  };
  const keySubscription = terminal.onKey(({ domEvent }) => {
    const copyConsumesInput =
      isCliCopyShortcut(domEvent) &&
      (domEvent.metaKey || terminal.hasSelection());
    const nativePasteShortcut = isCliPasteShortcut(domEvent);
    if (
      !MODIFIER_ONLY_KEYS.has(domEvent.key) &&
      !copyConsumesInput &&
      !nativePasteShortcut
    ) {
      followInput();
    }
  });
  const followCommittedInput = (event: Event): void => {
    if ((event as InputEvent).isComposing) return;
    followInput();
  };
  host.addEventListener("paste", followInput, true);
  host.addEventListener("compositionend", followInput, true);
  host.addEventListener("input", followCommittedInput, true);

  return () => {
    keySubscription.dispose();
    host.removeEventListener("paste", followInput, true);
    host.removeEventListener("compositionend", followInput, true);
    host.removeEventListener("input", followCommittedInput, true);
  };
}

export function installCliWindowFocusRestore(
  target: CliFocusTarget,
  hostWindow: Window,
  subscribeWindowFocus?: WindowFocusSubscriber,
): () => void {
  let targetWasFocused = target.hasFocus();
  let restoreOnActivation = false;
  let nativeFocusUnlisten: (() => void) | null = null;
  let disposed = false;

  const rememberTargetFocus = (): void => {
    targetWasFocused = target.hasFocus();
  };
  const releaseTargetFocus = (): void => {
    if (hostWindow.document.hasFocus()) {
      targetWasFocused = target.hasFocus();
    }
  };
  const rememberFocus = (): void => {
    restoreOnActivation = targetWasFocused || target.hasFocus();
  };
  const restoreFocus = (): void => {
    if (!restoreOnActivation) return;
    restoreOnActivation = false;
    if (target.canRestoreFocus()) {
      target.restoreFocus();
      targetWasFocused = true;
    }
  };
  const handleWindowFocusChanged = (focused: boolean): void => {
    if (focused) restoreFocus();
    else rememberFocus();
  };

  hostWindow.addEventListener("focusin", rememberTargetFocus);
  hostWindow.addEventListener("focusout", releaseTargetFocus);
  hostWindow.addEventListener("blur", rememberFocus);
  hostWindow.addEventListener("focus", restoreFocus);
  if (subscribeWindowFocus) {
    void subscribeWindowFocus(handleWindowFocusChanged).then(
      (unlisten) => {
        if (disposed) unlisten();
        else nativeFocusUnlisten = unlisten;
      },
      () => {
        // DOM focus events remain available as the browser fallback.
      },
    );
  }

  return () => {
    disposed = true;
    restoreOnActivation = false;
    nativeFocusUnlisten?.();
    nativeFocusUnlisten = null;
    hostWindow.removeEventListener("focusin", rememberTargetFocus);
    hostWindow.removeEventListener("focusout", releaseTargetFocus);
    hostWindow.removeEventListener("blur", rememberFocus);
    hostWindow.removeEventListener("focus", restoreFocus);
  };
}
