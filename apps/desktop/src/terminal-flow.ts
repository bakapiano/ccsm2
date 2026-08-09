export class LatestValue<T> {
  #value: T | undefined;

  set(value: T): void {
    this.#value = value;
  }

  take(): T | undefined {
    const value = this.#value;
    this.#value = undefined;
    return value;
  }

  clear(): void {
    this.#value = undefined;
  }
}

export function takeByteBatch(
  queue: Uint8Array[],
  budget: number,
): Uint8Array | undefined {
  if (queue.length === 0) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (queue.length > 0 && (length < budget || chunks.length === 0)) {
    const chunk = queue.shift()!;
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function runtimeStartCanCommit(
  exitedRuntimeIds: ReadonlySet<string>,
  runtimeId: string,
): boolean {
  return !exitedRuntimeIds.has(runtimeId);
}
