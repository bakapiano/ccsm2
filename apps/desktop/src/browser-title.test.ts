import { describe, expect, test } from "bun:test";

import { browserTabTitle } from "./browser-title";

describe("Browser Tab title", () => {
  test("uses and normalizes the native document title", () => {
    expect(browserTabTitle("  Example   Domain  ", "https://example.com")).toBe(
      "Example Domain",
    );
  });

  test("falls back to the hostname or Browser", () => {
    expect(browserTabTitle("", "https://www.example.com/path")).toBe(
      "example.com",
    );
    expect(browserTabTitle("", "about:blank")).toBe("Browser");
  });

  test("bounds untrusted page titles without splitting Unicode characters", () => {
    const title = `${"页".repeat(159)}😀tail`;
    const normalized = browserTabTitle(title, "https://example.com");
    expect(Array.from(normalized)).toHaveLength(160);
    expect(normalized.endsWith("😀")).toBe(true);
  });
});
