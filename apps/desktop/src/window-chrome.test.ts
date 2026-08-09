import { describe, expect, mock, test } from "bun:test";

import type { WindowChromeClient } from "./transport/desktop-client";
import { runWindowAction } from "./window-chrome";

describe("frameless window chrome", () => {
  test("routes controls to the window adapter", async () => {
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
    };

    await runWindowAction("minimize", client);
    await runWindowAction("maximize", client);
    await runWindowAction("close", client);

    expect(client.minimize).toHaveBeenCalledTimes(1);
    expect(client.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("forwards the selected application theme to the native window", async () => {
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
    };

    await client.setTheme("dark");
    await client.setTheme("light");

    expect(client.setTheme).toHaveBeenNthCalledWith(1, "dark");
    expect(client.setTheme).toHaveBeenNthCalledWith(2, "light");
  });
});
