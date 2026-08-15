import { expect, test } from "bun:test";

import { listWindow } from "./list-window";

test("a million-item list keeps a viewport-sized mount window", () => {
  const window = listWindow(1_000_000, 11_000_000, 660, 22);
  expect(window.end - window.start).toBe(70);
  expect(window.paddingBefore + window.paddingAfter).toBe(
    (1_000_000 - 70) * 22,
  );
});
