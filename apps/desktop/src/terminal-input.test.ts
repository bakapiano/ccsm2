import { describe, expect, test } from "bun:test";

import { TerminalInputWriter } from "./terminal-input";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("terminal input writer", () => {
  test("sends the first input immediately and coalesces an in-flight burst", async () => {
    const writes: Array<{ runtimeId: string; data: string }> = [];
    const pendingWrites: ReturnType<typeof deferred>[] = [];
    const writer = new TerminalInputWriter(
      (runtimeId, data) => {
        writes.push({ runtimeId, data });
        const pending = deferred();
        pendingWrites.push(pending);
        return pending.promise;
      },
      () => {},
    );

    writer.enqueue("runtime-1", "a");
    writer.enqueue("runtime-1", "b");
    writer.enqueue("runtime-1", "c");

    expect(writes).toEqual([{ runtimeId: "runtime-1", data: "a" }]);
    expect(writer.snapshot()).toMatchObject({
      enqueuedEvents: 3,
      writeBatches: 1,
      pendingEvents: 2,
      pendingCodeUnits: 2,
      writeInFlight: true,
    });

    pendingWrites[0]!.resolve();
    await Promise.resolve();
    expect(writes).toEqual([
      { runtimeId: "runtime-1", data: "a" },
      { runtimeId: "runtime-1", data: "bc" },
    ]);

    pendingWrites[1]!.resolve();
    await writer.drain();
    expect(writer.snapshot()).toMatchObject({
      writeBatches: 2,
      pendingEvents: 0,
      pendingCodeUnits: 0,
      writeInFlight: false,
    });
  });

  test("preserves runtime boundaries and resolves every drain waiter", async () => {
    const writes: string[] = [];
    const pendingWrites: ReturnType<typeof deferred>[] = [];
    const writer = new TerminalInputWriter(
      (runtimeId, data) => {
        writes.push(`${runtimeId}:${data}`);
        const pending = deferred();
        pendingWrites.push(pending);
        return pending.promise;
      },
      () => {},
    );

    writer.enqueue("runtime-1", "a");
    writer.enqueue("runtime-2", "b");
    writer.enqueue("runtime-2", "c");
    const drained = [writer.drain(), writer.drain()];

    pendingWrites[0]!.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["runtime-1:a", "runtime-2:bc"]);
    pendingWrites[1]!.resolve();
    await Promise.all(drained);
    expect(writer.snapshot().writeInFlight).toBe(false);
  });

  test("reports a failed batch and continues with queued input", async () => {
    const errors: unknown[] = [];
    const writes: string[] = [];
    const firstWrite = deferred();
    const writer = new TerminalInputWriter(
      (_runtimeId, data) => {
        writes.push(data);
        return writes.length === 1 ? firstWrite.promise : Promise.resolve();
      },
      (error) => errors.push(error),
    );

    writer.enqueue("runtime-1", "a");
    writer.enqueue("runtime-1", "b");
    const failure = new Error("write failed");
    firstWrite.reject(failure);
    await writer.drain();

    expect(writes).toEqual(["a", "b"]);
    expect(errors).toEqual([failure]);
  });

  test("ignores empty input", async () => {
    const writes: string[] = [];
    const writer = new TerminalInputWriter(
      (_runtimeId, data) => {
        writes.push(data);
        return Promise.resolve();
      },
      () => {},
    );

    writer.enqueue("runtime-1", "");
    await writer.drain();
    expect(writes).toEqual([]);
  });
});
