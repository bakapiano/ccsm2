import type { RuntimeEvent } from "./generated/RuntimeEvent";

const OUTPUT_FRAME = 0;
const ERROR_FRAME = 1;
const EXIT_FRAME = 2;
const TRAILER_BYTES = 3;
const textDecoder = new TextDecoder();

export type RuntimeStreamEvent =
  | { type: "output"; runtimeId: string; data: Uint8Array }
  | Exclude<RuntimeEvent, { type: "output" }>;

export function decodeRuntimeEventFrame(
  frame: ArrayBuffer,
): RuntimeStreamEvent {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength < TRAILER_BYTES) {
    throw new Error("runtime event frame is shorter than its trailer");
  }
  const kind = bytes[bytes.byteLength - 1];
  const runtimeIdLength =
    bytes[bytes.byteLength - TRAILER_BYTES] |
    (bytes[bytes.byteLength - TRAILER_BYTES + 1] << 8);
  const runtimeIdStart = bytes.byteLength - TRAILER_BYTES - runtimeIdLength;
  if (runtimeIdStart < 0) {
    throw new Error("runtime event frame has an invalid runtime ID length");
  }
  const runtimeId = textDecoder.decode(
    bytes.subarray(runtimeIdStart, bytes.byteLength - TRAILER_BYTES),
  );
  const payload = bytes.subarray(0, runtimeIdStart);
  switch (kind) {
    case OUTPUT_FRAME:
      return { type: "output", runtimeId, data: payload };
    case ERROR_FRAME:
      return { type: "error", runtimeId, message: textDecoder.decode(payload) };
    case EXIT_FRAME:
      if (payload.byteLength !== Uint32Array.BYTES_PER_ELEMENT) {
        throw new Error("runtime exit frame has an invalid payload length");
      }
      return {
        type: "exit",
        runtimeId,
        code: new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength,
        ).getUint32(0, true),
      };
    default:
      throw new Error(`runtime event frame has unknown kind ${kind}`);
  }
}
