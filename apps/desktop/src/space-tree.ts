import type { BootstrapDto } from "./generated/BootstrapDto";
import type { SpaceDto } from "./generated/SpaceDto";
import type { SpaceFolderDto } from "./generated/SpaceFolderDto";
import { inferSpaceName } from "./directory-picker";

export interface SpaceTreeActions {
  pickSpaceRoot(initialPath: string | null): Promise<string | null>;
  switchSpace(spaceId: string): Promise<void>;
  createSpace(
    name: string,
    rootPath: string,
    folderId: string | null,
  ): Promise<void>;
  renameSpace(spaceId: string, name: string): Promise<void>;
  deleteSpace(spaceId: string): Promise<void>;
  createFolder(name: string, parentId: string | null): Promise<void>;
  renameFolder(folderId: string, name: string): Promise<void>;
  setFolderCollapsed(folderId: string, collapsed: boolean): Promise<void>;
  deleteFolder(folderId: string): Promise<void>;
  moveSpace(
    spaceId: string,
    folderId: string | null,
    order: number,
  ): Promise<void>;
  moveFolder(
    folderId: string,
    parentId: string | null,
    order: number,
  ): Promise<void>;
}

export class SpaceTreeView {
  #state: BootstrapDto | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: SpaceTreeActions,
  ) {
    requiredElement(root, "#new-space").addEventListener("click", () => {
      void this.#promptCreateSpace(null);
    });
    requiredElement(root, "#new-folder").addEventListener("click", () => {
      void this.#promptCreateFolder(null);
    });
  }

  render(state: BootstrapDto): void {
    this.#state = state;
    const tree = requiredElement(this.root, "#space-tree");
    tree.replaceChildren();
    const rootFolders = this.#foldersForParent(null);
    for (const folder of rootFolders)
      tree.append(this.#renderFolder(folder, 0));
    const unfiled = this.#spacesForFolder(null);
    if (unfiled.length > 0 || rootFolders.length === 0) {
      const section = document.createElement("section");
      section.className = "tree-section unfiled-section";
      section.dataset.dropFolderId = "";
      section.innerHTML = '<div class="tree-section-label">Unfiled</div>';
      this.#bindDropTarget(section, null);
      for (const space of unfiled) section.append(this.#renderSpace(space, 0));
      tree.append(section);
    }
  }

  #renderFolder(folder: SpaceFolderDto, depth: number): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "folder-node";
    wrapper.dataset.folderId = folder.id;
    wrapper.style.setProperty("--tree-depth", String(depth));
    wrapper.draggable = true;
    wrapper.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-ccsm-folder", folder.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    this.#bindDropTarget(wrapper, folder.id);

    const row = document.createElement("div");
    row.className = "folder-row";
    const toggle = document.createElement("button");
    toggle.className = "folder-toggle";
    toggle.type = "button";
    toggle.setAttribute(
      "aria-label",
      `${folder.collapsed ? "Expand" : "Collapse"} ${folder.name}`,
    );
    toggle.textContent = folder.collapsed ? "▸" : "▾";
    toggle.addEventListener("click", () => {
      void this.actions.setFolderCollapsed(folder.id, !folder.collapsed);
    });
    const label = document.createElement("span");
    label.className = "folder-name";
    label.textContent = folder.name;
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    actions.append(
      actionButton("+", `New folder in ${folder.name}`, () =>
        this.#promptCreateFolder(folder.id),
      ),
      actionButton("S+", `New Space in ${folder.name}`, () =>
        this.#promptCreateSpace(folder.id),
      ),
      actionButton("✎", `Rename folder ${folder.name}`, () =>
        this.#renameFolder(folder),
      ),
      actionButton("×", `Delete folder ${folder.name}`, () =>
        this.#deleteFolder(folder),
      ),
    );
    row.append(toggle, label, actions);
    wrapper.append(row);

    if (!folder.collapsed) {
      const children = document.createElement("div");
      children.className = "folder-children";
      for (const child of this.#foldersForParent(folder.id)) {
        children.append(this.#renderFolder(child, depth + 1));
      }
      for (const space of this.#spacesForFolder(folder.id)) {
        children.append(this.#renderSpace(space, depth + 1));
      }
      wrapper.append(children);
    }
    return wrapper;
  }

  #renderSpace(space: SpaceDto, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "space-row";
    row.style.setProperty("--tree-depth", String(depth));
    row.draggable = true;
    row.dataset.spaceId = space.id;
    row.dataset.active = String(space.id === this.#state?.activeSpaceId);
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-ccsm-space", space.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });

    const open = document.createElement("button");
    open.className = "space-item";
    open.type = "button";
    open.title = space.rootPath;
    open.innerHTML =
      '<span class="space-icon" aria-hidden="true"></span><span class="space-name"></span>';
    open.querySelector(".space-name")!.textContent = space.name;
    open.addEventListener(
      "click",
      () => void this.actions.switchSpace(space.id),
    );

    const actions = document.createElement("span");
    actions.className = "tree-actions";
    actions.append(
      actionButton("✎", `Rename Space ${space.name}`, () =>
        this.#renameSpace(space),
      ),
      actionButton("×", `Delete Space ${space.name}`, () =>
        this.#deleteSpace(space),
      ),
    );
    row.append(open, actions);
    return row;
  }

  #foldersForParent(parentId: string | null): SpaceFolderDto[] {
    return (this.#state?.folders ?? [])
      .filter((folder) => folder.parentId === parentId)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  #spacesForFolder(folderId: string | null): SpaceDto[] {
    return (this.#state?.spaces ?? [])
      .filter((space) => space.folderId === folderId)
      .sort((left, right) => left.folderOrder - right.folderOrder);
  }

  #nextFolderOrder(parentId: string | null): number {
    const folders = this.#foldersForParent(parentId);
    return folders.length === 0
      ? 0
      : Math.max(...folders.map((folder) => folder.sortOrder)) + 1;
  }

  #nextSpaceOrder(folderId: string | null): number {
    const spaces = this.#spacesForFolder(folderId);
    return spaces.length === 0
      ? 0
      : Math.max(...spaces.map((space) => space.folderOrder)) + 1;
  }

  #bindDropTarget(element: HTMLElement, folderId: string | null): void {
    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      element.dataset.dragOver = "true";
    });
    element.addEventListener(
      "dragleave",
      () => delete element.dataset.dragOver,
    );
    element.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      delete element.dataset.dragOver;
      const spaceId = event.dataTransfer?.getData("application/x-ccsm-space");
      const movedFolderId = event.dataTransfer?.getData(
        "application/x-ccsm-folder",
      );
      if (spaceId) {
        void this.actions.moveSpace(
          spaceId,
          folderId,
          this.#nextSpaceOrder(folderId),
        );
      } else if (movedFolderId) {
        void this.actions.moveFolder(
          movedFolderId,
          folderId,
          this.#nextFolderOrder(folderId),
        );
      }
    });
  }

  async #promptCreateSpace(folderId: string | null): Promise<void> {
    const initialPath = this.#state?.activeSnapshot.space.rootPath ?? null;
    const rootPath = await this.actions.pickSpaceRoot(initialPath);
    if (!rootPath) return;
    const inferredName = inferSpaceName(rootPath);
    const name = window.prompt("Space name", inferredName);
    if (!name?.trim()) return;
    await this.actions.createSpace(name, rootPath, folderId);
  }

  async #promptCreateFolder(parentId: string | null): Promise<void> {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    await this.actions.createFolder(name, parentId);
  }

  async #renameSpace(space: SpaceDto): Promise<void> {
    const name = window.prompt("Space name", space.name);
    if (!name?.trim() || name.trim() === space.name) return;
    await this.actions.renameSpace(space.id, name);
  }

  async #renameFolder(folder: SpaceFolderDto): Promise<void> {
    const name = window.prompt("Folder name", folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    await this.actions.renameFolder(folder.id, name);
  }

  async #deleteSpace(space: SpaceDto): Promise<void> {
    if (
      !window.confirm(
        `Delete Space “${space.name}”? The disk folder is preserved.`,
      )
    )
      return;
    await this.actions.deleteSpace(space.id);
  }

  async #deleteFolder(folder: SpaceFolderDto): Promise<void> {
    if (
      !window.confirm(
        `Delete Folder “${folder.name}”? Children move to its parent.`,
      )
    )
      return;
    await this.actions.deleteFolder(folder.id);
  }
}

function actionButton(
  text: string,
  label: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tree-action";
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void action();
  });
  return button;
}

function requiredElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
