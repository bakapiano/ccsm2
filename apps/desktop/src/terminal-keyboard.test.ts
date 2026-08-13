import { describe, expect, test } from "bun:test";

import {
  cliShortcutInput,
  installCliInputFollow,
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
  test("follows Claude and Codex keyboard, paste, and IME input", () => {
    const host = new EventTarget();
    let provider: "shell" | "claude" | "codex" = "shell";
    let keyListener: (() => void) | null = null;
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

    keyListener!();
    host.dispatchEvent(new Event("paste"));
    expect(scrollCount).toBe(0);

    provider = "codex";
    keyListener!();
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
