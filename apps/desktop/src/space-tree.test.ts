import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { BootstrapDto } from "./generated/BootstrapDto";
import type { SpaceDto } from "./generated/SpaceDto";
import {
  MAX_SPACE_TREE_NAME_LENGTH,
  resolveSpaceDrop,
  type SpaceTreeActions,
  spaceTreeIconSvg,
  SpaceTreeView,
} from "./space-tree";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const source = await Bun.file(
  new URL("./space-tree.ts", import.meta.url),
).text();

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

function space(
  id: string,
  folderId: string | null,
  folderOrder: number,
): SpaceDto {
  return {
    id,
    name: id,
    icon: null,
    rootId: `root-${id}`,
    rootPath: `D:\\${id}`,
    folderId,
    folderOrder,
  };
}

describe("Space tree", () => {
  test("uses v1-style tree rows while keeping nested Space leaves iconless", () => {
    for (const kind of ["folder", "folder-open"] as const)
      expect(spaceTreeIconSvg(kind)).toContain("<svg");
    expect(css).toMatch(
      /\.folder-row,[\s\S]*\.space-row,[\s\S]*\.space-empty-row\s*\{[^}]*min-height:\s*28px/,
    );
    expect(css).toMatch(/\.space-resource-icon svg\s*\{[^}]*width:\s*14px/);
    expect(css).toMatch(/\.space-tree\s*\{[^}]*--tree-indent:\s*8px/);
    expect(css).toMatch(/\.space-indent-guides\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(
      /\.folder-row,[\s\S]*\.space-row,[\s\S]*\.space-empty-row\s*\{[^}]*grid-template-columns:\s*14px minmax\(0, 1fr\) auto/,
    );
    expect(css).toMatch(
      /\.folder-row,[\s\S]*\.space-row,[\s\S]*\.space-empty-row\s*\{[^}]*column-gap:\s*8px/,
    );
    expect(css).toMatch(/\.space-order\s*\{[^}]*text-align:\s*center/);
    expect(css).toMatch(
      /\.space-item:hover\s*\{[^}]*background:\s*transparent/,
    );
    expect(css).toMatch(/\.tree-actions\s*\{[^}]*display:\s*none/);
    expect(css).not.toContain(".folder-toggle");
    expect(source).not.toContain("TREE_TWISTIE_ICON");
    expect(source).not.toContain('data-icon="space"');
  });

  test("uses Pointer Events instead of WebView HTML drag", () => {
    expect(source).toMatch(
      /tree\.addEventListener\("pointerdown", this\.#onPointerDown\)/,
    );
    expect(source).not.toContain("dragstart");
    expect(css).toMatch(/\.space-item\s*\{[^}]*cursor:\s*grab/);
  });

  test("limits Space and Folder names to 64 Unicode characters", () => {
    expect(MAX_SPACE_TREE_NAME_LENGTH).toBe(64);
    expect(source.match(/maxLength: MAX_SPACE_TREE_NAME_LENGTH/g)).toHaveLength(
      4,
    );
  });

  test("moves by pointer, suppresses the trailing click, then clicks normally", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const moves: unknown[][] = [];
    let switches = 0;
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => void switches++,
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async () => {},
      deleteFolder: async () => {},
      moveSpace: async (...args) => void moves.push(args),
      moveFolder: async () => {},
    };
    const spaces = [space("source", "folder-a", 0)];
    const folders = [
      {
        id: "folder-a",
        parentId: null,
        name: "A",
        sortOrder: 0,
        collapsed: false,
      },
      {
        id: "folder-b",
        parentId: null,
        name: "B",
        sortOrder: 1,
        collapsed: false,
      },
    ];
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces,
      folders,
      activeSpaceId: "source",
      activeSnapshot: { space: spaces[0] },
    } as BootstrapDto);
    const sourceButton = requiredElement<HTMLButtonElement>(
      root,
      '[data-space-id="source"] .space-item',
    );
    expect(sourceButton.querySelector(".space-resource-icon")).toBeNull();
    const target = requiredElement<HTMLElement>(
      root,
      '[data-folder-id="folder-b"] > .folder-row',
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });

    sourceButton.dispatchEvent(pointerEvent("pointerdown", 0, 0));
    document.dispatchEvent(pointerEvent("pointermove", 12, 0));
    const ghost = requiredElement<HTMLElement>(
      document,
      ".space-tree-drag-ghost",
    );
    expect(ghost.textContent).toBe("source");
    expect(ghost.dataset.dropAllowed).toBe("true");
    expect(ghost.style.transform).toBe("translate3d(20px, -14px, 0)");
    document.dispatchEvent(pointerEvent("pointerup", 12, 0));
    sourceButton.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(moves).toEqual([["source", "folder-b", 0]]);
    expect(switches).toBe(0);
    expect(target.dataset.dragOver).toBeUndefined();
    expect(document.querySelector(".space-tree-drag-ghost")).toBeNull();

    await new Promise((resolve) => window.setTimeout(resolve, 1));
    sourceButton.click();
    expect(switches).toBe(1);
  });

  test("keeps folders one level deep from frontend controls", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const folderMoves: unknown[][] = [];
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => {},
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async () => {},
      deleteFolder: async () => {},
      moveSpace: async () => {},
      moveFolder: async (...args) => void folderMoves.push(args),
    };
    const folders = [
      {
        id: "folder-a",
        parentId: null,
        name: "A",
        sortOrder: 0,
        collapsed: false,
      },
      {
        id: "folder-b",
        parentId: null,
        name: "B",
        sortOrder: 1,
        collapsed: false,
      },
    ];
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces: [],
      folders,
      activeSpaceId: "active",
      activeSnapshot: { space: space("active", null, 0) },
    } as unknown as BootstrapDto);

    expect(
      requiredElement<HTMLButtonElement>(root, '[aria-label="New Space in A"]')
        .textContent,
    ).toBe("+");
    expect(root.querySelector('[aria-label="New folder in A"]')).toBeNull();

    const source = requiredElement<HTMLElement>(
      root,
      '[data-folder-id="folder-a"] > .folder-row',
    );
    const target = requiredElement<HTMLElement>(
      root,
      '[data-folder-id="folder-b"] > .folder-row',
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    source.dispatchEvent(pointerEvent("pointerdown", 0, 0));
    document.dispatchEvent(pointerEvent("pointermove", 12, 0));
    expect(
      requiredElement<HTMLElement>(document, ".space-tree-drag-ghost").dataset
        .dropAllowed,
    ).toBe("false");
    document.dispatchEvent(pointerEvent("pointerup", 12, 0));

    expect(folderMoves).toEqual([]);
    expect(target.dataset.dragOver).toBeUndefined();
  });

  test("toggles folders from the row without rendering a twistie button", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const collapsedChanges: unknown[][] = [];
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => {},
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async (...args) => void collapsedChanges.push(args),
      deleteFolder: async () => {},
      moveSpace: async () => {},
      moveFolder: async () => {},
    };
    const spaces = [space("child", "folder-a", 0)];
    const folders = [
      {
        id: "folder-a",
        parentId: null,
        name: "A",
        sortOrder: 0,
        collapsed: false,
      },
    ];
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces,
      folders,
      activeSpaceId: "child",
      activeSnapshot: { space: spaces[0] },
    } as unknown as BootstrapDto);

    const row = requiredElement<HTMLElement>(
      root,
      '[data-folder-id="folder-a"] > .folder-row',
    );
    expect(row.querySelector(".folder-toggle")).toBeNull();
    row.click();
    expect(collapsedChanges).toEqual([["folder-a", true]]);

    view.render({
      spaces,
      folders: [{ ...folders[0], collapsed: true }],
      activeSpaceId: "child",
      activeSnapshot: { space: spaces[0] },
    } as unknown as BootstrapDto);
    expect(root.querySelector('[data-space-id="child"]')).toBeNull();
  });

  test("aligns the Unfiled icon with folder icons", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => {},
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async () => {},
      deleteFolder: async () => {},
      moveSpace: async () => {},
      moveFolder: async () => {},
    };
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces: [space("loose", null, 0)],
      folders: [
        {
          id: "folder-a",
          parentId: null,
          name: "A",
          sortOrder: 0,
          collapsed: false,
        },
      ],
      activeSpaceId: "loose",
      activeSnapshot: { space: space("loose", null, 0) },
    } as unknown as BootstrapDto);

    const unfiled = requiredElement<HTMLElement>(root, ".tree-section-label");
    const firstElement = Array.from(unfiled.children).find(
      (child) => !child.classList.contains("space-indent-guides"),
    );
    expect(firstElement?.classList.contains("space-resource-icon")).toBe(true);
    expect(firstElement?.getAttribute("data-icon")).toBe("folder");
    expect(unfiled.querySelector(".space-order")).toBeNull();
  });

  test("numbers Spaces by sibling order in the folder icon column", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => {},
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async () => {},
      deleteFolder: async () => {},
      moveSpace: async () => {},
      moveFolder: async () => {},
    };
    const spaces = [
      space("second", "folder-a", 10),
      space("first", "folder-a", 2),
      space("loose", null, 0),
    ];
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces,
      folders: [
        {
          id: "folder-a",
          parentId: null,
          name: "A",
          sortOrder: 0,
          collapsed: false,
        },
      ],
      activeSpaceId: "first",
      activeSnapshot: { space: spaces[1] },
    } as unknown as BootstrapDto);

    expect(
      requiredElement(root, '[data-space-id="first"] .space-order').textContent,
    ).toBe("1");
    expect(
      requiredElement(root, '[data-space-id="second"] .space-order')
        .textContent,
    ).toBe("2");
    expect(
      requiredElement(root, '[data-space-id="loose"] .space-order').textContent,
    ).toBe("1");
    expect(
      requiredElement<HTMLElement>(
        root,
        '[data-folder-id="folder-a"]',
      ).style.getPropertyValue("--tree-depth"),
    ).toBe("0");
    expect(
      requiredElement<HTMLElement>(
        root,
        '[data-space-id="first"]',
      ).style.getPropertyValue("--tree-depth"),
    ).toBe("0");
    expect(
      requiredElement<HTMLElement>(
        root,
        '[data-space-id="loose"]',
      ).style.getPropertyValue("--tree-depth"),
    ).toBe("0");
  });

  test("shows an empty row when an expanded folder has no Spaces", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="new-space"></button>
      <button id="new-folder"></button>
      <nav id="space-tree"></nav>`;
    document.body.append(root);
    const actions: SpaceTreeActions = {
      pickSpaceRoot: async () => null,
      requestText: async () => null,
      requestConfirmation: async () => false,
      switchSpace: async () => {},
      createSpace: async () => {},
      renameSpace: async () => {},
      deleteSpace: async () => {},
      createFolder: async () => {},
      renameFolder: async () => {},
      setFolderCollapsed: async () => {},
      deleteFolder: async () => {},
      moveSpace: async () => {},
      moveFolder: async () => {},
    };
    const view = new SpaceTreeView(root, actions);
    view.render({
      spaces: [],
      folders: [
        {
          id: "folder-a",
          parentId: null,
          name: "A",
          sortOrder: 0,
          collapsed: false,
        },
      ],
      activeSpaceId: "active",
      activeSnapshot: { space: space("active", null, 0) },
    } as unknown as BootstrapDto);

    expect(
      requiredElement(root, '[data-folder-id="folder-a"] .space-empty-label')
        .textContent,
    ).toBe("No Spaces");
  });

  test("moves a Space to the end of a different Folder", () => {
    const spaces = [
      space("source", "folder-a", 0),
      space("target-1", "folder-b", 2),
      space("target-2", "folder-b", 7),
    ];

    expect(resolveSpaceDrop(spaces, "source", "folder-b")).toEqual({
      spaceId: "source",
      folderId: "folder-b",
      order: 8,
    });
    expect(resolveSpaceDrop(spaces, "source", "folder-a")).toBeNull();
    expect(resolveSpaceDrop(spaces, "missing", "folder-b")).toBeNull();
  });
});

function pointerEvent(type: string, clientX: number, clientY: number) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
}

function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
