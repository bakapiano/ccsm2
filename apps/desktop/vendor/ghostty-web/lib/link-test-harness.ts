import { BufferNamespace } from "./buffer";
import { Ghostty } from "./ghostty";
import type { Terminal } from "./terminal";
import type { ILink, ILinkProvider } from "./types";

export async function linkTestTerminal(output: string, cols = 80, rows = 12) {
  const ghostty = await Ghostty.load();
  const wasmTerm = ghostty.createTerminal(cols, rows);
  wasmTerm.write(output);
  const terminal = { wasmTerm, cols };
  return {
    ...terminal,
    buffer: new BufferNamespace(terminal as unknown as Terminal),
    dispose: () => wasmTerm.free(),
  };
}

export function providerLinks(provider: ILinkProvider, row: number) {
  return new Promise<ILink[]>((resolve) =>
    provider.provideLinks(row, (links) => resolve(links ?? [])),
  );
}
