import { describe, expect, test } from "bun:test";

import { GitScanVisibility } from "./git-scan-visibility";

describe("Git scan visibility", () => {
  test("defers the initial reconciliation until the panel becomes visible", () => {
    const visibility = new GitScanVisibility();

    expect(visibility.setVisible(false)).toBe(false);
    expect(visibility.setReady()).toBe(false);
    expect(visibility.setVisible(true)).toBe(true);

    const revision = visibility.beginScan();
    expect(visibility.completeScan(revision)).toBe(false);
  });

  test("coalesces hidden filesystem changes into one visible scan", () => {
    const visibility = new GitScanVisibility();
    visibility.setReady();
    visibility.setVisible(true);
    visibility.completeScan(visibility.beginScan());
    visibility.setVisible(false);

    expect(visibility.markDirty()).toBe(false);
    expect(visibility.markDirty()).toBe(false);
    expect(visibility.setVisible(true)).toBe(true);
  });

  test("keeps a change that arrives during a scan dirty", () => {
    const visibility = new GitScanVisibility();
    visibility.setReady();
    visibility.setVisible(true);
    const runningRevision = visibility.beginScan();

    expect(visibility.markDirty()).toBe(true);
    expect(visibility.completeScan(runningRevision)).toBe(true);
  });
});
