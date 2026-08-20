import { describe, expect, test } from "bun:test";

import { WindowsConptyInputCompatibility } from "./windows-conpty-input";

const encoder = new TextEncoder();

describe("WindowsConptyInputCompatibility", () => {
  test("tracks split Win32 input mode negotiation, disable, RIS, and reset", () => {
    const compatibility = windowsCompatibility();

    compatibility.observeOutput(encoder.encode("before\x1b[?90"));
    expect(compatibility.active).toBe(false);
    compatibility.observeOutput(encoder.encode("01hafter"));
    expect(compatibility.active).toBe(true);

    compatibility.observeOutput(encoder.encode("\x1b[?1004;9001l"));
    expect(compatibility.active).toBe(false);
    compatibility.observeOutput(encoder.encode("\x9b?9001h"));
    expect(compatibility.active).toBe(true);
    compatibility.observeOutput(encoder.encode("\x1bc"));
    expect(compatibility.active).toBe(false);

    compatibility.observeOutput(encoder.encode("\x1b[?9001h"));
    compatibility.reset();
    expect(compatibility.active).toBe(false);
  });

  test("encodes Ctrl+Enter as lossless Win32 key records", () => {
    const compatibility = activeCompatibility();

    expect(
      compatibility.encodeKeyDown(
        keyEvent("ControlLeft", "Control", {
          ctrlKey: true,
          keyCode: 0x11,
        }),
      ),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(
        keyEvent("Enter", "Enter", { ctrlKey: true, keyCode: 0x0d }),
      ),
    ).toBe("\x1b[13;28;10;1;8;1_");
    expect(
      compatibility.encodeKeyUp(
        keyEvent("Enter", "Enter", { ctrlKey: true, keyCode: 0x0d }),
      ),
    ).toBe("\x1b[13;28;10;0;8;1_");
    expect(
      compatibility.encodeKeyUp(
        keyEvent("ControlLeft", "Control", { keyCode: 0x11 }),
      ),
    ).toBeNull();
  });

  test("reconciles a missing modifier keyup from the next DOM event", () => {
    const compatibility = activeCompatibility();
    compatibility.encodeKeyDown(
      keyEvent("ControlLeft", "Control", {
        ctrlKey: true,
        keyCode: 0x11,
      }),
    );
    compatibility.encodeKeyDown(
      keyEvent("Enter", "Enter", { ctrlKey: true, keyCode: 0x0d }),
    );

    expect(
      compatibility.encodeKeyDown(keyEvent("KeyA", "a", { keyCode: 0x41 })),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(keyEvent("Enter", "Enter", { keyCode: 13 })),
    ).toBe("\x1b[13;28;13;1;0;1_");
  });

  test("preserves Shift+Enter and right-control enhanced-key state", () => {
    const compatibility = activeCompatibility();

    expect(
      compatibility.encodeKeyDown(
        keyEvent("ShiftLeft", "Shift", {
          shiftKey: true,
          keyCode: 0x10,
        }),
      ),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(
        keyEvent("Enter", "Enter", { shiftKey: true, keyCode: 0x0d }),
      ),
    ).toBe("\x1b[13;28;13;1;16;1_");
    compatibility.encodeKeyUp(
      keyEvent("Enter", "Enter", { shiftKey: true, keyCode: 0x0d }),
    );
    compatibility.encodeKeyUp(
      keyEvent("ShiftLeft", "Shift", { keyCode: 0x10 }),
    );

    expect(
      compatibility.encodeKeyDown(
        keyEvent("ControlRight", "Control", {
          ctrlKey: true,
          keyCode: 0x11,
        }),
      ),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(
        keyEvent("Enter", "Enter", { ctrlKey: true, keyCode: 0x0d }),
      ),
    ).toBe("\x1b[13;28;10;1;4;1_");
  });

  test("keeps text and Ctrl+C on the terminal encoder path", () => {
    const compatibility = activeCompatibility();

    expect(
      compatibility.encodeKeyDown(keyEvent("KeyA", "a", { keyCode: 0x41 })),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(
        keyEvent("KeyC", "c", { ctrlKey: true, keyCode: 0x43 }),
      ),
    ).toBeNull();
    expect(
      compatibility.encodeKeyDown(
        keyEvent("KeyC", "c", { keyCode: 0x43, metaKey: true }),
      ),
    ).toBeNull();
  });

  test("encodes non-legacy control, OEM, lock, and packet keys", () => {
    const compatibility = activeCompatibility();

    expect(
      compatibility.encodeKeyDown(
        keyEvent("KeyA", "a", { ctrlKey: true, keyCode: 0x41 }),
      ),
    ).toBe("\x1b[65;30;1;1;8;1_");
    expect(
      compatibility.encodeKeyDown(
        keyEvent("Semicolon", ";", {
          altKey: true,
          keyCode: 0xba,
          modifierStates: new Set(["NumLock", "CapsLock"]),
        }),
      ),
    ).toBe("\x1b[186;39;0;1;162;1_");
    expect(
      compatibility.encodeKeyDown(keyEvent("IntlYen", "¥", { ctrlKey: true })),
    ).toBe("\x1b[231;0;165;1;8;1_");
  });

  test("encodes target-key releases and tracks modifier releases locally", () => {
    const compatibility = activeCompatibility();
    compatibility.encodeKeyDown(
      keyEvent("ControlLeft", "Control", {
        ctrlKey: true,
        keyCode: 0x11,
      }),
    );
    compatibility.encodeKeyDown(
      keyEvent("KeyA", "a", { ctrlKey: true, keyCode: 0x41 }),
    );

    expect(
      compatibility.encodeKeyUp(
        keyEvent("KeyA", "a", { ctrlKey: true, keyCode: 0x41 }),
      ),
    ).toBe("\x1b[65;30;1;0;8;1_");
    expect(
      compatibility.encodeKeyUp(
        keyEvent("ControlLeft", "Control", { keyCode: 0x11 }),
      ),
    ).toBeNull();
    expect(
      compatibility.encodeKeyUp(keyEvent("KeyA", "a", { keyCode: 0x41 })),
    ).toBeNull();
  });

  test("keeps the compatibility boundary inactive off Windows", () => {
    const compatibility = new WindowsConptyInputCompatibility({
      isWindows: false,
    });
    compatibility.observeOutput(encoder.encode("\x1b[?9001h"));

    expect(compatibility.active).toBe(false);
    expect(
      compatibility.encodeKeyDown(keyEvent("Enter", "Enter", { keyCode: 13 })),
    ).toBeNull();
  });
});

function windowsCompatibility(): WindowsConptyInputCompatibility {
  return new WindowsConptyInputCompatibility({ isWindows: true });
}

function activeCompatibility(): WindowsConptyInputCompatibility {
  const compatibility = windowsCompatibility();
  compatibility.observeOutput(encoder.encode("\x1b[?9001h"));
  return compatibility;
}

function keyEvent(
  code: string,
  key: string,
  options: {
    altKey?: boolean;
    ctrlKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
    metaKey?: boolean;
    modifierStates?: ReadonlySet<string>;
    shiftKey?: boolean;
  } = {},
): KeyboardEvent {
  return {
    altKey: options.altKey ?? false,
    code,
    ctrlKey: options.ctrlKey ?? false,
    getModifierState: (modifier: string) =>
      options.modifierStates?.has(modifier) ?? false,
    isComposing: options.isComposing ?? false,
    key,
    keyCode: options.keyCode ?? 0,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
  } as KeyboardEvent;
}
