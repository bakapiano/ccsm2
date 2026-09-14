import type { ILink, ILinkProvider } from "./types";

/** Cache complete row scans in provider order: OSC 8, URL, then file paths. */
export class LinkDetector {
  private providers: ILinkProvider[] = [];
  private rows = new Map<number, Promise<ILink[]>>();
  private generation = 0;

  constructor(private terminal: ITerminalForLinkDetector) {}

  registerProvider(provider: ILinkProvider): void {
    this.providers.push(provider);
    this.invalidateCache();
  }

  async getLinkAt(col: number, row: number): Promise<ILink | undefined> {
    // A provider may finish after a PTY write/resize. Retry against the new
    // buffer, with a bound for providers that keep invalidating themselves.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const line = this.terminal.buffer.active.getLine(row);
      if (!line || col < 0 || col >= line.length || !line.getCell(col)) return;
      const generation = this.generation;
      let scan = this.rows.get(row);
      if (!scan) {
        scan = this.scanRow(row);
        if (generation === this.generation) this.rows.set(row, scan);
      }
      let links: ILink[];
      try {
        links = await scan;
      } catch (error) {
        if (this.rows.get(row) === scan) this.rows.delete(row);
        throw error;
      }
      if (generation !== this.generation) continue;
      return links.find((link) => this.isPositionInLink(col, row, link));
    }
    return undefined;
  }

  private async scanRow(row: number): Promise<ILink[]> {
    const result: ILink[] = [];
    for (const provider of this.providers) {
      const links = await new Promise<ILink[] | undefined>((resolve) =>
        provider.provideLinks(row, resolve),
      );
      if (links) result.push(...links);
    }
    return result;
  }

  private isPositionInLink(col: number, row: number, link: ILink): boolean {
    const { start, end } = link.range;
    return (
      row >= start.y &&
      row <= end.y &&
      (row !== start.y || col >= start.x) &&
      (row !== end.y || col <= end.x)
    );
  }

  invalidateCache(): void {
    this.generation += 1;
    this.rows.clear();
  }

  invalidateRows(_startRow: number, _endRow: number): void {
    // A logical link can begin on another row and include the changed cells.
    this.invalidateCache();
  }

  dispose(): void {
    this.invalidateCache();
    for (const provider of this.providers) provider.dispose?.();
    this.providers = [];
  }
}

export interface ITerminalForLinkDetector {
  buffer: {
    active: {
      getLine(y: number):
        | {
            length: number;
            getCell(x: number): { getHyperlinkId(): number } | undefined;
          }
        | undefined;
    };
  };
}
