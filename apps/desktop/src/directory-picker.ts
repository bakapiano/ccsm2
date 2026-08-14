import type { HostDirectoryListingDto } from "./generated/HostDirectoryListingDto";
import type { DirectoryBrowserClient } from "./transport/desktop-client";
import { describeError } from "./transport/desktop-client";

export interface DirectoryCrumb {
  label: string;
  path: string;
}

const DIRECTORY_PAGE_SIZE = 200;

export class DirectoryPickerDialog {
  #backdrop: HTMLElement | null = null;
  #listing: HostDirectoryListingDto | null = null;
  #selectedPath = "";
  #selectionValid = false;
  #workspaceRoot: string | null = null;
  #history: string[] = [];
  #historyCursor = -1;
  #pageOffset = 0;
  #requestGeneration = 0;
  #activeOperationId: string | null = null;
  #resolve: ((path: string | null) => void) | null = null;

  constructor(private readonly client: DirectoryBrowserClient) {}

  open(
    initialPath: string | null,
    workspaceRoot: string | null,
  ): Promise<string | null> {
    this.#finish(null);
    this.#workspaceRoot = workspaceRoot;
    this.#history = [];
    this.#historyCursor = -1;
    this.#pageOffset = 0;
    this.#listing = null;
    this.#selectedPath = "";
    this.#selectionValid = false;
    this.#backdrop = this.#createDialog();
    document.body.append(this.#backdrop);
    document.addEventListener("keydown", this.#onDocumentKeyDown, true);
    const result = new Promise<string | null>((resolve) => {
      this.#resolve = resolve;
    });
    void this.#browse(initialPath, true);
    return result;
  }

  #createDialog(): HTMLElement {
    const backdrop = document.createElement("div");
    backdrop.className = "directory-dialog-backdrop";
    backdrop.innerHTML = `
      <section class="directory-dialog" role="dialog" aria-modal="true" aria-labelledby="directory-dialog-title">
        <header class="directory-dialog-head">
          <h2 id="directory-dialog-title">Choose Space folder</h2>
          <button type="button" class="directory-dialog-close" aria-label="Close folder picker">×</button>
        </header>
        <div class="directory-toolbar">
          <div class="directory-nav-buttons">
            <button type="button" data-directory-nav="back" aria-label="Back" title="Back">←</button>
            <button type="button" data-directory-nav="forward" aria-label="Forward" title="Forward">→</button>
            <button type="button" data-directory-nav="up" aria-label="Up" title="Up">↑</button>
          </div>
          <form class="directory-address-form">
            <input class="directory-address" aria-label="Folder path" spellcheck="false" />
          </form>
        </div>
        <nav class="directory-breadcrumbs" aria-label="Folder breadcrumbs"></nav>
        <div class="directory-browser-body">
          <aside class="directory-starts" aria-label="Quick access"></aside>
          <div class="directory-list" role="listbox" aria-label="Folders"></div>
        </div>
        <div class="directory-selection" title="Selected folder"></div>
        <footer class="directory-dialog-foot">
          <div class="directory-create-slot">
            <button type="button" class="directory-new-folder">+ New folder</button>
          </div>
          <div class="directory-dialog-actions">
            <button type="button" class="directory-cancel">Cancel</button>
            <button type="button" class="directory-use primary">Use folder</button>
          </div>
        </footer>
        <div class="directory-message" role="status" aria-live="polite"></div>
      </section>
    `;

    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) this.#finish(null);
    });
    requiredElement(backdrop, ".directory-dialog-close").addEventListener(
      "click",
      () => this.#finish(null),
    );
    requiredElement(backdrop, ".directory-cancel").addEventListener(
      "click",
      () => this.#finish(null),
    );
    requiredElement(backdrop, ".directory-use").addEventListener(
      "click",
      () => {
        if (this.#selectionValid) this.#finish(this.#selectedPath);
      },
    );
    requiredElement(backdrop, '[data-directory-nav="back"]').addEventListener(
      "click",
      () => this.#goHistory(-1),
    );
    requiredElement(
      backdrop,
      '[data-directory-nav="forward"]',
    ).addEventListener("click", () => this.#goHistory(1));
    requiredElement(backdrop, '[data-directory-nav="up"]').addEventListener(
      "click",
      () => {
        if (this.#listing?.parent)
          void this.#browse(this.#listing.parent, true);
      },
    );
    requiredElement<HTMLFormElement>(
      backdrop,
      ".directory-address-form",
    ).addEventListener("submit", (event) => {
      event.preventDefault();
      const value = requiredElement<HTMLInputElement>(
        backdrop,
        ".directory-address",
      ).value;
      if (value.trim()) void this.#browse(value.trim(), true);
    });
    requiredElement(backdrop, ".directory-new-folder").addEventListener(
      "click",
      () => this.#showCreateFolder(),
    );
    return backdrop;
  }

  async #browse(
    path: string | null,
    pushHistory: boolean,
    offset = 0,
  ): Promise<void> {
    this.#cancelActiveOperation();
    const generation = ++this.#requestGeneration;
    const operationId = crypto.randomUUID();
    this.#activeOperationId = operationId;
    this.#setLoading(true);
    this.#setMessage("Loading…");
    try {
      const listing = await this.client.browse({
        path,
        workspaceRoot: this.#workspaceRoot,
        operationId,
        offset,
        limit: DIRECTORY_PAGE_SIZE,
      });
      if (generation !== this.#requestGeneration || !this.#backdrop) return;
      this.#listing = listing;
      this.#pageOffset = offset;
      this.#selectedPath = listing.path;
      this.#selectionValid = listing.exists;
      if (pushHistory) {
        this.#history = this.#history.slice(0, this.#historyCursor + 1);
        if (this.#history.at(-1) !== listing.path)
          this.#history.push(listing.path);
        this.#historyCursor = this.#history.length - 1;
      }
      requiredElement<HTMLInputElement>(
        this.#backdrop,
        ".directory-address",
      ).value = listing.path;
      this.#renderListing();
      this.#setMessage(listing.exists ? "" : "Directory not found.");
    } catch (error) {
      if (generation !== this.#requestGeneration || !this.#backdrop) return;
      this.#selectionValid = false;
      this.#setMessage(describeError(error), true);
    } finally {
      if (this.#activeOperationId === operationId)
        this.#activeOperationId = null;
      if (generation === this.#requestGeneration && this.#backdrop)
        this.#setLoading(false);
    }
  }

  #renderListing(): void {
    if (!this.#backdrop || !this.#listing) return;
    const starts = requiredElement(this.#backdrop, ".directory-starts");
    starts.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "directory-starts-heading";
    heading.textContent = "Quick access";
    starts.append(heading);
    for (const start of this.#listing.starts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-start";
      button.title = start.path;
      button.innerHTML = '<span aria-hidden="true">▰</span><span></span>';
      button.lastElementChild!.textContent = start.label;
      button.dataset.active = String(
        pathsEqual(start.path, this.#listing.path),
      );
      button.addEventListener(
        "click",
        () => void this.#browse(start.path, true),
      );
      starts.append(button);
    }

    const breadcrumbs = requiredElement(
      this.#backdrop,
      ".directory-breadcrumbs",
    );
    breadcrumbs.replaceChildren();
    for (const [index, crumb] of directoryBreadcrumbs(
      this.#listing.path,
    ).entries()) {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.textContent = "›";
        separator.setAttribute("aria-hidden", "true");
        breadcrumbs.append(separator);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = crumb.label;
      button.title = crumb.path;
      button.addEventListener(
        "click",
        () => void this.#browse(crumb.path, true),
      );
      breadcrumbs.append(button);
    }

    const list = requiredElement(this.#backdrop, ".directory-list");
    list.replaceChildren();
    if (!this.#listing.exists) {
      list.append(emptyState("Directory not found."));
    } else if (this.#listing.entries.length === 0) {
      list.append(emptyState("This folder is empty."));
    } else {
      for (const entry of this.#listing.entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "directory-row";
        button.role = "option";
        button.title = entry.path;
        button.dataset.path = entry.path;
        button.dataset.selected = String(
          pathsEqual(entry.path, this.#selectedPath),
        );
        button.innerHTML =
          '<span class="directory-row-icon" aria-hidden="true">▰</span><span></span>';
        button.lastElementChild!.textContent = entry.name;
        button.addEventListener("click", () => this.#select(entry.path));
        button.addEventListener(
          "dblclick",
          () => void this.#browse(entry.path, true),
        );
        list.append(button);
      }
      if (this.#pageOffset > 0) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "directory-page-previous";
        button.textContent = `Previous ${DIRECTORY_PAGE_SIZE} folders`;
        button.addEventListener("click", () => {
          const listing = this.#listing;
          if (listing) {
            void this.#browse(
              listing.path,
              false,
              Math.max(0, this.#pageOffset - DIRECTORY_PAGE_SIZE),
            );
          }
        });
        list.append(button);
      }
      if (this.#listing.nextOffset !== null) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "directory-load-more";
        button.textContent = `Next ${DIRECTORY_PAGE_SIZE} folders`;
        button.addEventListener("click", () => {
          const listing = this.#listing;
          if (listing && listing.nextOffset !== null)
            void this.#browse(listing.path, false, listing.nextOffset);
        });
        list.append(button);
      }
    }
    this.#renderSelection();
    this.#updateNavigation();
  }

  #select(path: string): void {
    this.#selectedPath = path;
    this.#selectionValid = true;
    this.#backdrop
      ?.querySelectorAll<HTMLElement>(".directory-row")
      .forEach((row) => {
        row.dataset.selected = String(pathsEqual(row.dataset.path ?? "", path));
      });
    this.#renderSelection();
  }

  #renderSelection(): void {
    if (!this.#backdrop) return;
    const selection = requiredElement(this.#backdrop, ".directory-selection");
    selection.textContent = this.#selectedPath || "No folder selected";
    selection.title = this.#selectedPath || "No folder selected";
    requiredElement<HTMLButtonElement>(
      this.#backdrop,
      ".directory-use",
    ).disabled = !this.#selectionValid;
  }

  #goHistory(delta: number): void {
    const next = this.#historyCursor + delta;
    if (next < 0 || next >= this.#history.length) return;
    this.#historyCursor = next;
    void this.#browse(this.#history[next], false);
  }

  #showCreateFolder(): void {
    if (!this.#backdrop || !this.#listing?.exists) return;
    const slot = requiredElement(this.#backdrop, ".directory-create-slot");
    slot.innerHTML = `
      <form class="directory-create-form">
        <input aria-label="New folder name" placeholder="Folder name" maxlength="120" />
        <button type="submit" class="primary">Create</button>
        <button type="button" data-cancel-create>Cancel</button>
      </form>
    `;
    const input = requiredElement<HTMLInputElement>(slot, "input");
    requiredElement(slot, "[data-cancel-create]").addEventListener(
      "click",
      () => this.#hideCreateFolder(),
    );
    requiredElement<HTMLFormElement>(slot, "form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.#createFolder(input.value);
      },
    );
    input.focus();
  }

  #hideCreateFolder(): void {
    if (!this.#backdrop) return;
    const slot = requiredElement(this.#backdrop, ".directory-create-slot");
    slot.innerHTML =
      '<button type="button" class="directory-new-folder">+ New folder</button>';
    requiredElement(slot, ".directory-new-folder").addEventListener(
      "click",
      () => this.#showCreateFolder(),
    );
  }

  async #createFolder(rawName: string): Promise<void> {
    if (!this.#listing || !rawName.trim()) return;
    this.#setLoading(true);
    this.#setMessage("Creating folder…");
    try {
      const created = await this.client.create({
        parentPath: this.#listing.path,
        name: rawName.trim(),
      });
      this.#hideCreateFolder();
      await this.#browse(created.path, true);
    } catch (error) {
      this.#setMessage(describeError(error), true);
      this.#setLoading(false);
    }
  }

  #setLoading(loading: boolean): void {
    if (!this.#backdrop) return;
    this.#backdrop.dataset.loading = String(loading);
    this.#backdrop
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => {
        if (!button.classList.contains("directory-dialog-close"))
          button.disabled = loading;
      });
    requiredElement<HTMLInputElement>(
      this.#backdrop,
      ".directory-address",
    ).disabled = loading;
    if (!loading) {
      this.#renderSelection();
      this.#updateNavigation();
    }
  }

  #updateNavigation(): void {
    if (!this.#backdrop) return;
    requiredElement<HTMLButtonElement>(
      this.#backdrop,
      '[data-directory-nav="back"]',
    ).disabled = this.#historyCursor <= 0;
    requiredElement<HTMLButtonElement>(
      this.#backdrop,
      '[data-directory-nav="forward"]',
    ).disabled =
      this.#historyCursor < 0 ||
      this.#historyCursor >= this.#history.length - 1;
    requiredElement<HTMLButtonElement>(
      this.#backdrop,
      '[data-directory-nav="up"]',
    ).disabled = !this.#listing?.parent;
  }

  #setMessage(message: string, error = false): void {
    if (!this.#backdrop) return;
    const element = requiredElement(this.#backdrop, ".directory-message");
    element.textContent = message;
    element.dataset.error = String(error);
  }

  readonly #onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.#finish(null);
  };

  #finish(path: string | null): void {
    if (!this.#backdrop && !this.#resolve) return;
    this.#requestGeneration += 1;
    this.#cancelActiveOperation();
    document.removeEventListener("keydown", this.#onDocumentKeyDown, true);
    this.#backdrop?.remove();
    this.#backdrop = null;
    this.#pageOffset = 0;
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(path);
  }

  #cancelActiveOperation(): void {
    const operationId = this.#activeOperationId;
    this.#activeOperationId = null;
    if (operationId) void this.client.cancel(operationId);
  }
}

export function directoryBreadcrumbs(path: string): DirectoryCrumb[] {
  if (!path) return [];
  if (/^[a-z]:[\\/]/i.test(path)) {
    const normalized = path.replace(/[\\/]+/g, "\\");
    const parts = normalized.split("\\").filter(Boolean);
    let current = `${parts[0]}\\`;
    const result: DirectoryCrumb[] = [{ label: parts[0], path: current }];
    for (const part of parts.slice(1)) {
      current = `${current.replace(/\\$/, "")}\\${part}`;
      result.push({ label: part, path: current });
    }
    return result;
  }
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  let current = "";
  const result: DirectoryCrumb[] = [{ label: "/", path: "/" }];
  for (const part of parts) {
    current += `/${part}`;
    result.push({ label: part, path: current });
  }
  return result;
}

export function inferSpaceName(path: string): string {
  return path.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

function pathsEqual(left: string, right: string): boolean {
  return /^[a-z]:/i.test(left) || /^[a-z]:/i.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function emptyState(message: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "directory-empty";
  element.textContent = message;
  return element;
}

function requiredElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
