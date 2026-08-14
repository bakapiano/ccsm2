export class GitScanVisibility {
  #visible = false;
  #ready = false;
  #dirtyRevision = 1;
  #completedRevision = 0;

  setReady(): boolean {
    this.#ready = true;
    return this.shouldScan;
  }

  setVisible(visible: boolean): boolean {
    this.#visible = visible;
    return this.shouldScan;
  }

  markDirty(): boolean {
    this.#dirtyRevision += 1;
    return this.shouldScan;
  }

  beginScan(): number {
    return this.#dirtyRevision;
  }

  completeScan(revision: number): boolean {
    this.#completedRevision = Math.max(this.#completedRevision, revision);
    return this.shouldScan;
  }

  get shouldScan(): boolean {
    return (
      this.#ready &&
      this.#visible &&
      this.#dirtyRevision > this.#completedRevision
    );
  }
}
