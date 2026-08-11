import type { BootstrapDto } from "./generated/BootstrapDto";
import type { SpaceDto } from "./generated/SpaceDto";
import type { SpaceFolderDto } from "./generated/SpaceFolderDto";
import { inferSpaceName } from "./directory-picker";

export type SpaceTreeIconKind = "folder" | "folder-open";

type SpaceTreeDragItem =
  | { kind: "space"; id: string }
  | { kind: "folder"; id: string };

interface SpaceTreePointerDrag {
  pointerId: number;
  item: SpaceTreeDragItem;
  source: HTMLElement;
  startX: number;
  startY: number;
  started: boolean;
  target: HTMLElement | null;
  ghost: HTMLElement | null;
}

const TREE_DRAG_THRESHOLD_PX = 4;
const TREE_DRAG_GHOST_OFFSET_X = 8;
const TREE_DRAG_GHOST_HALF_HEIGHT = 14;
export const MAX_SPACE_TREE_NAME_LENGTH = 64;

export interface SpaceDropMove {
  spaceId: string;
  folderId: string | null;
  order: number;
}

export interface SpaceTreeTextRequest {
  title: string;
  label: string;
  value?: string;
  message?: string;
  confirmLabel: string;
  maxLength?: number;
}

export interface SpaceTreeConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
}

export function resolveSpaceDrop(
  spaces: readonly SpaceDto[],
  spaceId: string,
  folderId: string | null,
): SpaceDropMove | null {
  const space = spaces.find((candidate) => candidate.id === spaceId);
  if (!space || space.folderId === folderId) return null;
  const orders = spaces
    .filter((candidate) => candidate.folderId === folderId)
    .map((candidate) => candidate.folderOrder);
  return {
    spaceId,
    folderId,
    order: orders.length === 0 ? 0 : Math.max(...orders) + 1,
  };
}

export function spaceTreeIconSvg(kind: SpaceTreeIconKind): string {
  return SPACE_TREE_ICONS[kind];
}

export interface SpaceTreeActions {
  pickSpaceRoot(initialPath: string | null): Promise<string | null>;
  requestText(request: SpaceTreeTextRequest): Promise<string | null>;
  requestConfirmation(request: SpaceTreeConfirmationRequest): Promise<boolean>;
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
  #pointerDrag: SpaceTreePointerDrag | null = null;
  #suppressClick = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: SpaceTreeActions,
  ) {
    const tree = requiredElement(root, "#space-tree");
    tree.addEventListener("pointerdown", this.#onPointerDown);
    tree.addEventListener("click", this.#onClickCapture, true);
    root.ownerDocument.addEventListener("pointermove", this.#onPointerMove, {
      capture: true,
    });
    root.ownerDocument.addEventListener("pointerup", this.#onPointerUp, {
      capture: true,
    });
    root.ownerDocument.addEventListener(
      "pointercancel",
      this.#onPointerCancel,
      {
        capture: true,
      },
    );
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
    const section = document.createElement("section");
    section.className = "tree-section unfiled-section";
    section.dataset.dropFolderId = "";
    section.setAttribute("role", "none");
    const label = document.createElement("div");
    label.className = "tree-section-label";
    label.setAttribute("role", "treeitem");
    label.dataset.dropFolderId = "";
    label.innerHTML = `${indentGuides(0)}<span class="space-resource-icon" data-icon="folder" aria-hidden="true">${spaceTreeIconSvg("folder")}</span><span class="tree-section-name">Unfiled</span>`;
    section.append(label);
    const unfiledChildren = document.createElement("div");
    unfiledChildren.className = "folder-children";
    unfiledChildren.setAttribute("role", "group");
    for (const [index, space] of unfiled.entries())
      unfiledChildren.append(this.#renderSpace(space, 0, index + 1));
    section.append(unfiledChildren);
    tree.append(section);
  }

  #renderFolder(folder: SpaceFolderDto, depth: number): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "folder-node";
    wrapper.dataset.folderId = folder.id;
    wrapper.setAttribute("role", "none");
    wrapper.style.setProperty("--tree-depth", String(depth));

    const row = document.createElement("div");
    row.className = "folder-row";
    row.dataset.dropFolderId = folder.id;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-expanded", String(!folder.collapsed));
    const guides = document.createElement("span");
    guides.className = "space-indent-guides";
    guides.innerHTML = indentGuides(depth);
    const icon = document.createElement("span");
    const iconKind = folder.collapsed ? "folder" : "folder-open";
    icon.className = "space-resource-icon";
    icon.dataset.icon = iconKind;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = spaceTreeIconSvg(iconKind);
    const label = document.createElement("span");
    label.className = "folder-name";
    label.textContent = folder.name;
    row.addEventListener("click", () => {
      void this.actions.setFolderCollapsed(folder.id, !folder.collapsed);
    });
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    actions.append(
      actionButton("+", `New Space in ${folder.name}`, () =>
        this.#promptCreateSpace(folder.id),
      ),
      actionButton("✎", `Rename folder ${folder.name}`, () =>
        this.#renameFolder(folder),
      ),
      actionButton("×", `Delete folder ${folder.name}`, () =>
        this.#deleteFolder(folder),
      ),
    );
    row.append(guides, icon, label, actions);
    wrapper.append(row);

    if (!folder.collapsed) {
      const children = document.createElement("div");
      children.className = "folder-children";
      children.setAttribute("role", "group");
      const childFolders = this.#foldersForParent(folder.id);
      const childSpaces = this.#spacesForFolder(folder.id);
      for (const child of childFolders) {
        children.append(this.#renderFolder(child, depth + 1));
      }
      for (const [index, space] of childSpaces.entries()) {
        children.append(this.#renderSpace(space, depth, index + 1));
      }
      if (childFolders.length === 0 && childSpaces.length === 0)
        children.append(this.#renderEmptyFolder(depth));
      wrapper.append(children);
    }
    return wrapper;
  }

  #renderSpace(space: SpaceDto, depth: number, ordinal: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "space-row";
    row.style.setProperty("--tree-depth", String(depth));
    row.dataset.spaceId = space.id;
    row.dataset.active = String(space.id === this.#state?.activeSpaceId);
    row.setAttribute("role", "treeitem");
    row.setAttribute(
      "aria-selected",
      String(space.id === this.#state?.activeSpaceId),
    );

    const guides = document.createElement("span");
    guides.className = "space-indent-guides";
    guides.innerHTML = indentGuides(depth);

    const order = document.createElement("span");
    order.className = "space-order";
    order.textContent = String(ordinal);

    const open = document.createElement("button");
    open.className = "space-item";
    open.type = "button";
    open.title = space.rootPath;
    open.innerHTML = `<span class="space-name"></span>`;
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
    row.append(guides, order, open, actions);
    return row;
  }

  #renderEmptyFolder(depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "space-empty-row";
    row.style.setProperty("--tree-depth", String(depth));
    row.innerHTML = `${indentGuides(depth)}<span class="space-empty-marker"></span><span class="space-empty-label">No Spaces</span>`;
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

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch")
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".tree-action")) return;
    const space = target.closest<HTMLElement>(".space-row[data-space-id]");
    const folderRow = target.closest<HTMLElement>(".folder-row");
    const folder = folderRow?.parentElement?.matches(
      ".folder-node[data-folder-id]",
    )
      ? folderRow.parentElement
      : null;
    const source = space ?? folderRow;
    const item: SpaceTreeDragItem | null = space?.dataset.spaceId
      ? { kind: "space", id: space.dataset.spaceId }
      : folder?.dataset.folderId
        ? { kind: "folder", id: folder.dataset.folderId }
        : null;
    if (!source || !item) return;
    this.#pointerDrag = {
      pointerId: event.pointerId,
      item,
      source,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      target: null,
      ghost: null,
    };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const drag = this.#pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (distance < TREE_DRAG_THRESHOLD_PX) return;
      drag.started = true;
      drag.source.dataset.dragging = "true";
      requiredElement(this.root, "#space-tree").dataset.pointerDragging =
        "true";
      drag.ghost = this.#createPointerGhost(drag);
    }
    event.preventDefault();
    this.#positionPointerGhost(drag, event.clientX, event.clientY);
    const hit = this.root.ownerDocument.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    const target =
      hit instanceof Element
        ? hit.closest<HTMLElement>("[data-drop-folder-id]")
        : null;
    const tree = requiredElement(this.root, "#space-tree");
    this.#setPointerTarget(
      target &&
        tree.contains(target) &&
        this.#isPointerDropTargetAllowed(drag.item, target)
        ? target
        : null,
    );
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const drag = this.#pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.started) {
      event.preventDefault();
      this.#suppressClick = true;
      window.setTimeout(() => (this.#suppressClick = false), 0);
      const folderId = drag.target?.dataset.dropFolderId || null;
      if (drag.target) this.#commitPointerDrop(drag.item, folderId);
    }
    this.#finishPointerDrag();
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    if (this.#pointerDrag?.pointerId === event.pointerId)
      this.#finishPointerDrag();
  };

  readonly #onClickCapture = (event: MouseEvent): void => {
    if (!this.#suppressClick) return;
    this.#suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  #setPointerTarget(target: HTMLElement | null): void {
    const drag = this.#pointerDrag;
    if (!drag || drag.target === target) return;
    if (drag.target) delete drag.target.dataset.dragOver;
    drag.target = target;
    if (target) target.dataset.dragOver = "true";
    if (drag.ghost) drag.ghost.dataset.dropAllowed = String(Boolean(target));
  }

  #isPointerDropTargetAllowed(
    item: SpaceTreeDragItem,
    target: HTMLElement,
  ): boolean {
    if (item.kind === "space") return true;
    return (target.dataset.dropFolderId ?? "") === "";
  }

  #createPointerGhost(drag: SpaceTreePointerDrag): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "space-tree-drag-ghost";
    ghost.dataset.kind = drag.item.kind;
    ghost.dataset.dropAllowed = "false";
    const icon = drag.source
      .querySelector<HTMLElement>(".space-resource-icon")
      ?.cloneNode(true);
    if (icon instanceof HTMLElement) ghost.append(icon);
    const label = document.createElement("span");
    label.className = "space-tree-drag-ghost-label";
    label.textContent =
      drag.source.querySelector<HTMLElement>(".space-name, .folder-name")
        ?.textContent ?? "";
    ghost.append(label);
    this.root.ownerDocument.body.append(ghost);
    return ghost;
  }

  #positionPointerGhost(
    drag: SpaceTreePointerDrag,
    clientX: number,
    clientY: number,
  ): void {
    if (!drag.ghost) return;
    drag.ghost.style.transform = `translate3d(${clientX + TREE_DRAG_GHOST_OFFSET_X}px, ${clientY - TREE_DRAG_GHOST_HALF_HEIGHT}px, 0)`;
  }

  #commitPointerDrop(item: SpaceTreeDragItem, folderId: string | null): void {
    if (item.kind === "space") {
      const move = resolveSpaceDrop(
        this.#state?.spaces ?? [],
        item.id,
        folderId,
      );
      if (move)
        void this.actions.moveSpace(move.spaceId, move.folderId, move.order);
      return;
    }
    if (folderId !== null) return;
    void this.actions.moveFolder(
      item.id,
      folderId,
      this.#nextFolderOrder(folderId),
    );
  }

  #finishPointerDrag(): void {
    const drag = this.#pointerDrag;
    if (!drag) return;
    if (drag.target) delete drag.target.dataset.dragOver;
    drag.ghost?.remove();
    delete drag.source.dataset.dragging;
    delete requiredElement(this.root, "#space-tree").dataset.pointerDragging;
    this.#pointerDrag = null;
  }

  async #promptCreateSpace(folderId: string | null): Promise<void> {
    const initialPath = this.#state?.activeSnapshot.space.rootPath ?? null;
    const rootPath = await this.actions.pickSpaceRoot(initialPath);
    if (!rootPath) return;
    const inferredName = inferSpaceName(rootPath);
    const name = await this.actions.requestText({
      title: "New Space",
      label: "Space name",
      value: inferredName,
      message: `Root folder: ${rootPath}`,
      confirmLabel: "Create Space",
      maxLength: MAX_SPACE_TREE_NAME_LENGTH,
    });
    if (!name) return;
    await this.actions.createSpace(name, rootPath, folderId);
  }

  async #promptCreateFolder(parentId: string | null): Promise<void> {
    const name = await this.actions.requestText({
      title: "New Folder",
      label: "Folder name",
      confirmLabel: "Create Folder",
      maxLength: MAX_SPACE_TREE_NAME_LENGTH,
    });
    if (!name) return;
    await this.actions.createFolder(name, parentId);
  }

  async #renameSpace(space: SpaceDto): Promise<void> {
    const name = await this.actions.requestText({
      title: `Rename “${space.name}”`,
      label: "Space name",
      value: space.name,
      confirmLabel: "Rename",
      maxLength: MAX_SPACE_TREE_NAME_LENGTH,
    });
    if (!name || name === space.name) return;
    await this.actions.renameSpace(space.id, name);
  }

  async #renameFolder(folder: SpaceFolderDto): Promise<void> {
    const name = await this.actions.requestText({
      title: `Rename “${folder.name}”`,
      label: "Folder name",
      value: folder.name,
      confirmLabel: "Rename",
      maxLength: MAX_SPACE_TREE_NAME_LENGTH,
    });
    if (!name || name === folder.name) return;
    await this.actions.renameFolder(folder.id, name);
  }

  async #deleteSpace(space: SpaceDto): Promise<void> {
    const confirmed = await this.actions.requestConfirmation({
      title: `Delete Space “${space.name}”?`,
      message:
        "This stops its CLI runtimes and deletes its tabs and CCSM data. The root folder and files on disk are preserved.",
      confirmLabel: "Delete Space",
    });
    if (!confirmed) return;
    await this.actions.deleteSpace(space.id);
  }

  async #deleteFolder(folder: SpaceFolderDto): Promise<void> {
    const confirmed = await this.actions.requestConfirmation({
      title: `Delete Folder “${folder.name}”?`,
      message:
        "The folder is removed from the Space tree. Its child folders and Spaces move to the parent.",
      confirmLabel: "Delete Folder",
    });
    if (!confirmed) return;
    await this.actions.deleteFolder(folder.id);
  }
}

const SPACE_TREE_ICONS: Record<SpaceTreeIconKind, string> = {
  folder: `<svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.5 1.5h6.5v6.5h-13z"></path></svg>`,
  "folder-open": `<svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.5 1.5h6.5l-1.4 6.5H2.4z"></path><path d="M1.5 6V4.5h5L8 6"></path></svg>`,
};

function indentGuides(depth: number): string {
  return Array.from(
    { length: depth },
    () => '<span class="space-indent-guide"></span>',
  ).join("");
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
