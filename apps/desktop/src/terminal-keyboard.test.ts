import { describe, expect, test } from "bun:test";

import {
  cliShortcutInput,
  installCliInputFollow,
  installCliWindowFocusRestore,
  isAgentCliCopyShortcut,
} from "./terminal-keyboard";

const noModifiers = {
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};

describe("cliShortcutInput", () => {
  test("reserves Ctrl/Cmd+C for copy only in Agent CLI Tabs", () => {
    const ctrlC = { ...noModifiers, code: "KeyC", ctrlKey: true };
    const cmdC = { ...noModifiers, code: "KeyC", metaKey: true };

    expect(isAgentCliCopyShortcut("claude", ctrlC)).toBe(true);
    expect(isAgentCliCopyShortcut("codex", ctrlC)).toBe(true);
    expect(isAgentCliCopyShortcut("copilot", cmdC)).toBe(true);
    expect(isAgentCliCopyShortcut("shell", ctrlC)).toBe(false);
    expect(isAgentCliCopyShortcut(null, ctrlC)).toBe(false);
  });

  test("maps Codex Ctrl+Enter and Shift+Enter to legacy Alt+Enter", () => {
    const ctrlEnter = cliShortcutInput("codex", {
      ...noModifiers,
      code: "Enter",
      ctrlKey: true,
    });
    const shiftEnter = cliShortcutInput("codex", {
      ...noModifiers,
      code: "Enter",
      shiftKey: true,
    });

    expect(ctrlEnter).toBe("\x1b\r");
    expect(shiftEnter).toBe("\x1b\r");
    expect(
      [...shiftEnter!].map((character) => character.charCodeAt(0)),
    ).toEqual([0x1b, 0x0d]);
    expect(shiftEnter).not.toContain("[13;3u");
  });

  test("leaves Claude and shell modified Enter to terminal negotiation", () => {
    const ctrlEnter = { ...noModifiers, code: "Enter", ctrlKey: true };
    const shiftEnter = { ...noModifiers, code: "Enter", shiftKey: true };
    expect(cliShortcutInput("claude", ctrlEnter)).toBeNull();
    expect(cliShortcutInput("claude", shiftEnter)).toBeNull();
    expect(cliShortcutInput("shell", ctrlEnter)).toBeNull();
    expect(cliShortcutInput("shell", shiftEnter)).toBeNull();
  });

  test("does not consume additional modifier combinations", () => {
    expect(
      cliShortcutInput("codex", {
        ...noModifiers,
        code: "Enter",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBeNull();
    expect(
      cliShortcutInput("codex", {
        ...noModifiers,
        code: "NumpadEnter",
        ctrlKey: true,
      }),
    ).toBeNull();
  });
});

describe("installCliInputFollow", () => {
  test("follows Claude and Codex input while modifier-only keys preserve scrollback", () => {
    const host = new EventTarget();
    let provider: "shell" | "claude" | "codex" = "shell";
    let keyListener: ((event: { domEvent: KeyboardEvent }) => void) | null =
      null;
    let scrollCount = 0;
    const dispose = installCliInputFollow(
      {
        onKey(listener) {
          keyListener = listener;
          return { dispose: () => (keyListener = null) };
        },
        scrollToBottom() {
          scrollCount += 1;
        },
      },
      host,
      () => provider,
    );

    keyListener!({ domEvent: { key: "a" } as KeyboardEvent });
    host.dispatchEvent(new Event("paste"));
    expect(scrollCount).toBe(0);

    provider = "codex";
    keyListener!({ domEvent: { key: "Control" } as KeyboardEvent });
    keyListener!({ domEvent: { key: "Shift" } as KeyboardEvent });
    keyListener!({ domEvent: { key: "Alt" } as KeyboardEvent });
    keyListener!({
      domEvent: {
        key: "c",
        code: "KeyC",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
      } as KeyboardEvent,
    });
    keyListener!({
      domEvent: {
        key: "v",
        code: "KeyV",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
      } as KeyboardEvent,
    });
    expect(scrollCount).toBe(0);

    keyListener!({ domEvent: { key: "a" } as KeyboardEvent });
    host.dispatchEvent(new Event("paste"));
    expect(scrollCount).toBe(2);

    provider = "claude";
    host.dispatchEvent(new Event("compositionend"));
    expect(scrollCount).toBe(3);

    dispose();
    host.dispatchEvent(new Event("paste"));
    expect(keyListener).toBeNull();
    expect(scrollCount).toBe(3);
  });
});

describe("installCliWindowFocusRestore", () => {
  function focusWindow(documentHasFocus = true): {
    hostWindow: Window;
    setDocumentFocus(focused: boolean): void;
  } {
    let focused = documentHasFocus;
    const hostWindow = new EventTarget() as Window;
    Object.defineProperty(hostWindow, "document", {
      value: { hasFocus: () => focused },
    });
    return {
      hostWindow,
      setDocumentFocus: (next) => (focused = next),
    };
  }

  test("restores CLI input focus when the application window returns", () => {
    const { hostWindow } = focusWindow();
    let hasFocus = true;
    let canRestoreFocus = true;
    let restoreCount = 0;
    const dispose = installCliWindowFocusRestore(
      {
        hasFocus: () => hasFocus,
        canRestoreFocus: () => canRestoreFocus,
        restoreFocus: () => {
          hasFocus = true;
          restoreCount += 1;
        },
      },
      hostWindow,
    );

    hostWindow.dispatchEvent(new Event("blur"));
    hasFocus = false;
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(1);

    hostWindow.dispatchEvent(new Event("blur"));
    hasFocus = false;
    canRestoreFocus = false;
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(1);

    canRestoreFocus = true;
    hasFocus = true;
    hostWindow.dispatchEvent(new Event("blur"));
    hasFocus = false;
    dispose();
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(1);
  });

  test("keeps the current focus when CLI input was not focused", () => {
    const { hostWindow } = focusWindow();
    let restoreCount = 0;
    const dispose = installCliWindowFocusRestore(
      {
        hasFocus: () => false,
        canRestoreFocus: () => true,
        restoreFocus: () => (restoreCount += 1),
      },
      hostWindow,
    );

    hostWindow.dispatchEvent(new Event("blur"));
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(0);
    dispose();
  });

  test("restores CLI input from the native window focus signal", async () => {
    const { hostWindow } = focusWindow();
    let hasFocus = true;
    let restoreCount = 0;
    let unlistenCount = 0;
    let nativeFocusListener: ((focused: boolean) => void) | null = null;
    const dispose = installCliWindowFocusRestore(
      {
        hasFocus: () => hasFocus,
        canRestoreFocus: () => true,
        restoreFocus: () => {
          hasFocus = true;
          restoreCount += 1;
        },
      },
      hostWindow,
      async (listener) => {
        nativeFocusListener = listener;
        return () => (unlistenCount += 1);
      },
    );
    await Promise.resolve();

    nativeFocusListener!(false);
    hasFocus = false;
    nativeFocusListener!(true);
    expect(restoreCount).toBe(1);

    dispose();
    expect(unlistenCount).toBe(1);
  });

  test("remembers CLI focus when element blur arrives before window blur", () => {
    const { hostWindow, setDocumentFocus } = focusWindow();
    let hasFocus = true;
    let restoreCount = 0;
    const dispose = installCliWindowFocusRestore(
      {
        hasFocus: () => hasFocus,
        canRestoreFocus: () => true,
        restoreFocus: () => {
          hasFocus = true;
          restoreCount += 1;
        },
      },
      hostWindow,
    );

    setDocumentFocus(false);
    hasFocus = false;
    hostWindow.dispatchEvent(new Event("focusout"));
    hostWindow.dispatchEvent(new Event("blur"));
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(1);
    dispose();
  });

  test("releases CLI focus after focus moves inside the application", () => {
    const { hostWindow } = focusWindow();
    let hasFocus = true;
    let restoreCount = 0;
    const dispose = installCliWindowFocusRestore(
      {
        hasFocus: () => hasFocus,
        canRestoreFocus: () => true,
        restoreFocus: () => (restoreCount += 1),
      },
      hostWindow,
    );

    hasFocus = false;
    hostWindow.dispatchEvent(new Event("focusout"));
    hostWindow.dispatchEvent(new Event("blur"));
    hostWindow.dispatchEvent(new Event("focus"));
    expect(restoreCount).toBe(0);
    dispose();
  });
});
