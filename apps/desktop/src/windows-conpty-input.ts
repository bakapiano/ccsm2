const ESC = "\x1b";
const WIN32_INPUT_MODE = 9001;
const VK_PACKET = 0xe7;

const RIGHT_ALT_PRESSED = 0x0001;
const LEFT_ALT_PRESSED = 0x0002;
const RIGHT_CTRL_PRESSED = 0x0004;
const LEFT_CTRL_PRESSED = 0x0008;
const SHIFT_PRESSED = 0x0010;
const NUMLOCK_ON = 0x0020;
const SCROLLLOCK_ON = 0x0040;
const CAPSLOCK_ON = 0x0080;
const ENHANCED_KEY = 0x0100;

interface Win32KeyDefinition {
  virtualKey: number;
  scanCode: number;
  enhanced?: boolean;
}

type ParserState = "ground" | "escape" | "csi";
export type WindowsConptyInputProfile = "default" | "codex";

const WIN32_KEY_BY_CODE: Record<string, Win32KeyDefinition> = {
  Backspace: { virtualKey: 0x08, scanCode: 0x0e },
  Tab: { virtualKey: 0x09, scanCode: 0x0f },
  Enter: { virtualKey: 0x0d, scanCode: 0x1c },
  ShiftLeft: { virtualKey: 0x10, scanCode: 0x2a },
  ShiftRight: { virtualKey: 0x10, scanCode: 0x36 },
  ControlLeft: { virtualKey: 0x11, scanCode: 0x1d },
  ControlRight: { virtualKey: 0x11, scanCode: 0x1d, enhanced: true },
  AltLeft: { virtualKey: 0x12, scanCode: 0x38 },
  AltRight: { virtualKey: 0x12, scanCode: 0x38, enhanced: true },
  Pause: { virtualKey: 0x13, scanCode: 0x45 },
  CapsLock: { virtualKey: 0x14, scanCode: 0x3a },
  Escape: { virtualKey: 0x1b, scanCode: 0x01 },
  Space: { virtualKey: 0x20, scanCode: 0x39 },
  PageUp: { virtualKey: 0x21, scanCode: 0x49, enhanced: true },
  PageDown: { virtualKey: 0x22, scanCode: 0x51, enhanced: true },
  End: { virtualKey: 0x23, scanCode: 0x4f, enhanced: true },
  Home: { virtualKey: 0x24, scanCode: 0x47, enhanced: true },
  ArrowLeft: { virtualKey: 0x25, scanCode: 0x4b, enhanced: true },
  ArrowUp: { virtualKey: 0x26, scanCode: 0x48, enhanced: true },
  ArrowRight: { virtualKey: 0x27, scanCode: 0x4d, enhanced: true },
  ArrowDown: { virtualKey: 0x28, scanCode: 0x50, enhanced: true },
  PrintScreen: { virtualKey: 0x2c, scanCode: 0x37, enhanced: true },
  Insert: { virtualKey: 0x2d, scanCode: 0x52, enhanced: true },
  Delete: { virtualKey: 0x2e, scanCode: 0x53, enhanced: true },
  MetaLeft: { virtualKey: 0x5b, scanCode: 0x5b, enhanced: true },
  MetaRight: { virtualKey: 0x5c, scanCode: 0x5c, enhanced: true },
  ContextMenu: { virtualKey: 0x5d, scanCode: 0x5d, enhanced: true },
  Numpad0: { virtualKey: 0x60, scanCode: 0x52 },
  Numpad1: { virtualKey: 0x61, scanCode: 0x4f },
  Numpad2: { virtualKey: 0x62, scanCode: 0x50 },
  Numpad3: { virtualKey: 0x63, scanCode: 0x51 },
  Numpad4: { virtualKey: 0x64, scanCode: 0x4b },
  Numpad5: { virtualKey: 0x65, scanCode: 0x4c },
  Numpad6: { virtualKey: 0x66, scanCode: 0x4d },
  Numpad7: { virtualKey: 0x67, scanCode: 0x47 },
  Numpad8: { virtualKey: 0x68, scanCode: 0x48 },
  Numpad9: { virtualKey: 0x69, scanCode: 0x49 },
  NumpadMultiply: { virtualKey: 0x6a, scanCode: 0x37 },
  NumpadAdd: { virtualKey: 0x6b, scanCode: 0x4e },
  NumpadSubtract: { virtualKey: 0x6d, scanCode: 0x4a },
  NumpadDecimal: { virtualKey: 0x6e, scanCode: 0x53 },
  NumpadDivide: { virtualKey: 0x6f, scanCode: 0x35, enhanced: true },
  NumpadEnter: { virtualKey: 0x0d, scanCode: 0x1c, enhanced: true },
  NumLock: { virtualKey: 0x90, scanCode: 0x45, enhanced: true },
  ScrollLock: { virtualKey: 0x91, scanCode: 0x46 },
};

const LETTER_SCAN_CODES = [
  0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
  0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
];
for (let index = 0; index < LETTER_SCAN_CODES.length; index += 1) {
  const letter = String.fromCharCode(0x41 + index);
  WIN32_KEY_BY_CODE[`Key${letter}`] = {
    virtualKey: 0x41 + index,
    scanCode: LETTER_SCAN_CODES[index],
  };
}

const DIGIT_SCAN_CODES = [
  0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
];
for (let digit = 0; digit <= 9; digit += 1) {
  WIN32_KEY_BY_CODE[`Digit${digit}`] = {
    virtualKey: 0x30 + digit,
    scanCode: DIGIT_SCAN_CODES[digit],
  };
}

const FUNCTION_SCAN_CODES = [
  0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76,
];
for (let index = 0; index < FUNCTION_SCAN_CODES.length; index += 1) {
  WIN32_KEY_BY_CODE[`F${index + 1}`] = {
    virtualKey: 0x70 + index,
    scanCode: FUNCTION_SCAN_CODES[index],
  };
}

const OEM_SCAN_CODES: Record<string, number> = {
  Minus: 0x0c,
  Equal: 0x0d,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Backslash: 0x2b,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  IntlBackslash: 0x56,
};
const OEM_VIRTUAL_KEYS: Record<string, number> = {
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  IntlBackslash: 0xe2,
};
for (const [code, scanCode] of Object.entries(OEM_SCAN_CODES)) {
  WIN32_KEY_BY_CODE[code] = {
    virtualKey: OEM_VIRTUAL_KEYS[code],
    scanCode,
  };
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Implements Microsoft's Win32 Input Mode boundary between a browser terminal
 * and ConPTY. The protocol is documented in microsoft/terminal#4999.
 */
export class WindowsConptyInputCompatibility {
  readonly #isWindows: boolean;
  readonly #pressedModifiers = new Set<string>();
  readonly #encodedKeyups = new Set<string>();
  #parserState: ParserState = "ground";
  #csiBody = "";
  #win32InputMode = false;

  constructor(options: { isWindows?: boolean } = {}) {
    this.#isWindows = options.isWindows ?? browserRunsOnWindows();
  }

  get active(): boolean {
    return this.#isWindows && this.#win32InputMode;
  }

  observeOutput(data: Uint8Array): void {
    if (!this.#isWindows) return;
    for (const byte of data) this.#observeByte(byte);
  }

  reset(): void {
    this.#parserState = "ground";
    this.#csiBody = "";
    this.#setWin32InputMode(false);
  }

  encodeKeyDown(
    event: KeyboardEvent,
    profile: WindowsConptyInputProfile = "default",
  ): string | null {
    if (MODIFIER_CODES.has(event.code)) {
      if (this.active) this.#pressedModifiers.add(event.code);
      return null;
    }
    if (usesTerminalEncoder(event)) return null;
    const encoded = this.#encodeKeyEvent(event, true, profile);
    if (encoded !== null && event.code && !MODIFIER_CODES.has(event.code)) {
      this.#encodedKeyups.add(event.code);
    }
    return encoded;
  }

  encodeKeyUp(
    event: KeyboardEvent,
    profile: WindowsConptyInputProfile = "default",
  ): string | null {
    if (MODIFIER_CODES.has(event.code)) {
      this.#pressedModifiers.delete(event.code);
      return null;
    }
    if (!this.#encodedKeyups.delete(event.code)) {
      return null;
    }
    return this.#encodeKeyEvent(event, false, profile);
  }

  #encodeKeyEvent(
    event: KeyboardEvent,
    keyDown: boolean,
    profile: WindowsConptyInputProfile,
  ): string | null {
    if (!this.active || event.isComposing || event.keyCode === 229) return null;

    const definition = win32KeyDefinition(event);
    if (!definition) return null;
    const codexCtrlEnter = this.#isCodexCtrlEnter(event, profile);
    const unicodeChar = codexCtrlEnter
      ? 0x0d
      : win32UnicodeChar(event, keyDown);
    const controlKeyState = codexCtrlEnter
      ? this.#shiftEnterControlKeyState(event, definition)
      : this.#controlKeyState(event, definition);
    return `${ESC}[${definition.virtualKey};${definition.scanCode};${unicodeChar};${keyDown ? 1 : 0};${controlKeyState};1_`;
  }

  #isCodexCtrlEnter(
    event: KeyboardEvent,
    profile: WindowsConptyInputProfile,
  ): boolean {
    const control =
      event.ctrlKey ||
      this.#pressedModifiers.has("ControlLeft") ||
      this.#pressedModifiers.has("ControlRight");
    const shift =
      event.shiftKey ||
      this.#pressedModifiers.has("ShiftLeft") ||
      this.#pressedModifiers.has("ShiftRight");
    const alt =
      event.altKey ||
      this.#pressedModifiers.has("AltLeft") ||
      this.#pressedModifiers.has("AltRight");
    const meta =
      event.metaKey ||
      this.#pressedModifiers.has("MetaLeft") ||
      this.#pressedModifiers.has("MetaRight");
    return (
      profile === "codex" &&
      event.code === "Enter" &&
      control &&
      !shift &&
      !alt &&
      !meta
    );
  }

  #shiftEnterControlKeyState(
    event: KeyboardEvent,
    definition: Win32KeyDefinition,
  ): number {
    let state = (definition.enhanced ? ENHANCED_KEY : 0) | SHIFT_PRESSED;
    if (modifierState(event, "NumLock")) state |= NUMLOCK_ON;
    if (modifierState(event, "ScrollLock")) state |= SCROLLLOCK_ON;
    if (modifierState(event, "CapsLock")) state |= CAPSLOCK_ON;
    return state;
  }

  #controlKeyState(
    event: KeyboardEvent,
    definition: Win32KeyDefinition,
  ): number {
    let state = definition.enhanced ? ENHANCED_KEY : 0;

    const rightCtrl = this.#pressedModifiers.has("ControlRight");
    const leftCtrl = this.#pressedModifiers.has("ControlLeft");
    if (rightCtrl) state |= RIGHT_CTRL_PRESSED;
    if (leftCtrl) state |= LEFT_CTRL_PRESSED;
    if (event.ctrlKey && !rightCtrl && !leftCtrl) state |= LEFT_CTRL_PRESSED;

    const rightAlt = this.#pressedModifiers.has("AltRight");
    const leftAlt = this.#pressedModifiers.has("AltLeft");
    if (rightAlt) state |= RIGHT_ALT_PRESSED;
    if (leftAlt) state |= LEFT_ALT_PRESSED;
    if (event.altKey && !rightAlt && !leftAlt) state |= LEFT_ALT_PRESSED;

    if (
      event.shiftKey ||
      this.#pressedModifiers.has("ShiftLeft") ||
      this.#pressedModifiers.has("ShiftRight")
    ) {
      state |= SHIFT_PRESSED;
    }
    if (modifierState(event, "NumLock")) state |= NUMLOCK_ON;
    if (modifierState(event, "ScrollLock")) state |= SCROLLLOCK_ON;
    if (modifierState(event, "CapsLock")) state |= CAPSLOCK_ON;
    return state;
  }

  #observeByte(byte: number): void {
    if (this.#parserState === "ground") {
      if (byte === 0x1b) this.#parserState = "escape";
      else if (byte === 0x9b) this.#beginCsi();
      return;
    }
    if (this.#parserState === "escape") {
      if (byte === 0x5b) this.#beginCsi();
      else {
        if (byte === 0x63) this.#setWin32InputMode(false);
        this.#parserState = byte === 0x1b ? "escape" : "ground";
      }
      return;
    }

    if (byte >= 0x40 && byte <= 0x7e) {
      this.#finishCsi(String.fromCharCode(byte));
      return;
    }
    if (byte === 0x1b) {
      this.#parserState = "escape";
      this.#csiBody = "";
      return;
    }
    if (this.#csiBody.length >= 64) {
      this.#parserState = "ground";
      this.#csiBody = "";
      return;
    }
    this.#csiBody += String.fromCharCode(byte);
  }

  #beginCsi(): void {
    this.#parserState = "csi";
    this.#csiBody = "";
  }

  #finishCsi(final: string): void {
    if (
      (final === "h" || final === "l") &&
      this.#csiBody.startsWith("?") &&
      this.#csiBody
        .slice(1)
        .split(";")
        .some((parameter) => Number(parameter) === WIN32_INPUT_MODE)
    ) {
      this.#setWin32InputMode(final === "h");
    }
    this.#parserState = "ground";
    this.#csiBody = "";
  }

  #setWin32InputMode(enabled: boolean): void {
    if (this.#win32InputMode === enabled) return;
    this.#win32InputMode = enabled;
    this.#pressedModifiers.clear();
    this.#encodedKeyups.clear();
  }
}

function usesTerminalEncoder(event: KeyboardEvent): boolean {
  if (event.metaKey) return true;
  if (
    event.code === "KeyC" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return true;
  }
  if (event.key.length !== 1) return false;
  if (modifierState(event, "AltGraph")) return true;
  return !event.ctrlKey && !event.altKey;
}

function win32KeyDefinition(event: KeyboardEvent): Win32KeyDefinition | null {
  const mapped = WIN32_KEY_BY_CODE[event.code];
  const eventVirtualKey =
    event.keyCode > 0 && event.keyCode <= 0xffff && event.keyCode !== 229
      ? event.keyCode
      : null;
  if (mapped) {
    return {
      ...mapped,
      virtualKey: eventVirtualKey ?? mapped.virtualKey,
    };
  }
  if (event.key.length === 1) {
    return {
      virtualKey: eventVirtualKey ?? VK_PACKET,
      scanCode: 0,
    };
  }
  return null;
}

function win32UnicodeChar(event: KeyboardEvent, keyDown: boolean): number {
  if (MODIFIER_CODES.has(event.code)) return 0;
  const altGraph = modifierState(event, "AltGraph");
  if ((event.altKey || event.metaKey) && !altGraph) return 0;
  if (event.ctrlKey && !altGraph) {
    if (event.code === "Enter" || event.code === "NumpadEnter") return 0x0a;
    if (event.code === "Space" || event.code === "Digit2") return 0;
    if (/^Key[A-Z]$/u.test(event.code)) return event.code.charCodeAt(3) - 0x40;
    const controlCharacters: Record<string, number> = {
      BracketLeft: 0x1b,
      Backslash: 0x1c,
      BracketRight: 0x1d,
      Digit6: 0x1e,
      Minus: 0x1f,
      Slash: 0x7f,
    };
    if (controlCharacters[event.code] !== undefined)
      return controlCharacters[event.code];
  }

  if (event.key.length === 1) return event.key.charCodeAt(0);
  if (event.code === "Enter" || event.code === "NumpadEnter") return 0x0d;
  if (event.code === "Tab") return 0x09;
  if (event.code === "Backspace") return keyDown ? 0x08 : 0;
  if (event.code === "Escape") return 0x1b;
  return 0;
}

function modifierState(event: KeyboardEvent, key: string): boolean {
  try {
    return event.getModifierState?.(key) ?? false;
  } catch {
    return false;
  }
}

function browserRunsOnWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /windows|win32|win64/iu.test(
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
  );
}
