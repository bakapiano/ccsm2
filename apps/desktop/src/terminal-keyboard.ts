import type { ProviderKind } from "./generated/ProviderKind";

type ModifierKeyEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

interface CliInputTerminal {
  onKey(listener: () => void): { dispose(): void };
  scrollToBottom(): void;
}

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

export function isAgentCliCopyShortcut(
  provider: ProviderKind | null,
  event: ModifierKeyEvent,
): boolean {
  return (
    provider !== null &&
    provider !== "shell" &&
    event.code === "KeyC" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey
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
  const keySubscription = terminal.onKey(followInput);
  host.addEventListener("paste", followInput, true);
  host.addEventListener("compositionend", followInput, true);

  return () => {
    keySubscription.dispose();
    host.removeEventListener("paste", followInput, true);
    host.removeEventListener("compositionend", followInput, true);
  };
}
