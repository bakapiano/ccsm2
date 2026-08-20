import { describe, expect, test } from "bun:test";

import { decodeRuntimeEventFrame } from "./runtime-channel";

const textEncoder = new TextEncoder();

function frame(
  kind: number,
  runtimeId: string,
  payload: Uint8Array,
): ArrayBuffer {
  const runtimeIdBytes = textEncoder.encode(runtimeId);
  const bytes = new Uint8Array(payload.byteLength + runtimeIdBytes.length + 3);
  bytes.set(payload);
  bytes.set(runtimeIdBytes, payload.byteLength);
  const trailer = bytes.byteLength - 3;
  bytes[trailer] = runtimeIdBytes.length & 0xff;
  bytes[trailer + 1] = runtimeIdBytes.length >>> 8;
  bytes[trailer + 2] = kind;
  return bytes.buffer;
}

describe("runtime binary channel", () => {
  test("decodes output as a zero-copy byte view", () => {
    const buffer = frame(0, "runtime-1", new Uint8Array([0, 1, 127, 255]));
    const event = decodeRuntimeEventFrame(buffer);
    expect(event).toEqual({
      type: "output",
      runtimeId: "runtime-1",
      data: new Uint8Array([0, 1, 127, 255]),
    });
    expect(event.type === "output" && event.data.buffer).toBe(buffer);
  });

  test("decodes UTF-8 errors and little-endian exit codes", () => {
    expect(
      decodeRuntimeEventFrame(
        frame(1, "runtime-2", textEncoder.encode("PTY 错误")),
      ),
    ).toEqual({
      type: "error",
      runtimeId: "runtime-2",
      message: "PTY 错误",
    });
    expect(
      decodeRuntimeEventFrame(
        frame(2, "runtime-3", new Uint8Array([0x78, 0x56, 0x34, 0x12])),
      ),
    ).toEqual({ type: "exit", runtimeId: "runtime-3", code: 0x1234_5678 });
  });

  test("rejects malformed frames", () => {
    expect(() => decodeRuntimeEventFrame(new ArrayBuffer(2))).toThrow(
      "shorter than its trailer",
    );
    expect(() =>
      decodeRuntimeEventFrame(frame(9, "runtime-4", new Uint8Array())),
    ).toThrow("unknown kind 9");
    expect(() =>
      decodeRuntimeEventFrame(frame(2, "runtime-5", new Uint8Array([1, 2]))),
    ).toThrow("invalid payload length");
  });
});
