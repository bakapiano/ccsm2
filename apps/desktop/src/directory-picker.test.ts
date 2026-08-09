import { describe, expect, test } from "bun:test";

import { directoryBreadcrumbs, inferSpaceName } from "./directory-picker";

describe("Space directory picker", () => {
  test("builds cross-platform breadcrumbs and an inferred Space name", () => {
    expect(directoryBreadcrumbs("D:\\cssm\\ccsm2")).toEqual([
      { label: "D:", path: "D:\\" },
      { label: "cssm", path: "D:\\cssm" },
      { label: "ccsm2", path: "D:\\cssm\\ccsm2" },
    ]);
    expect(directoryBreadcrumbs("/home/me/project").at(-1)).toEqual({
      label: "project",
      path: "/home/me/project",
    });
    expect(inferSpaceName("D:\\cssm\\ccsm2\\")).toBe("ccsm2");
  });
});
