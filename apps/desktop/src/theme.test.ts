import { describe, expect, mock, test } from "bun:test";

import {
  nextTheme,
  storedTheme,
  THEME_STORAGE_KEY,
  ThemeController,
} from "./theme";

describe("application theme", () => {
  test("defaults to light and toggles both ways", () => {
    expect(storedTheme(null)).toBe("light");
    expect(storedTheme("unknown")).toBe("light");
    expect(storedTheme("dark")).toBe("dark");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  test("persists and broadcasts a committed toggle", () => {
    const values = new Map<string, string>();
    const apply = mock((_theme: "light" | "dark") => {});
    const controller = new ThemeController(
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      apply,
    );
    const listener = mock((_theme: "light" | "dark") => {});
    controller.subscribe(listener);

    expect(controller.toggle()).toBe("dark");
    expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(apply).toHaveBeenLastCalledWith("dark");
    expect(listener).toHaveBeenCalledWith("dark");
  });
});
