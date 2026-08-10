import { describe, expect, test } from "bun:test";

import { dockNewTabMenuPosition } from "./dock-new-tab";

describe("Dockview New Tab action", () => {
  test("anchors the menu to the right edge without leaving the viewport", () => {
    expect(
      dockNewTabMenuPosition({ right: 900, bottom: 30 }, 164, 1_000),
    ).toEqual({ left: 736, top: 34 });
    expect(
      dockNewTabMenuPosition({ right: 120, bottom: 30 }, 164, 300),
    ).toEqual({ left: 8, top: 34 });
  });
});
