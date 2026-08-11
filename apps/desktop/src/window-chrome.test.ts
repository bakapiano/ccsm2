import { describe, expect, mock, test } from "bun:test";

import type { WindowChromeClient } from "./transport/desktop-client";
import { runWindowAction, runWindowResize } from "./window-chrome";

describe("frameless window chrome", () => {
  test("routes controls to the window adapter", async () => {
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      startResizeDragging: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
      subscribeCloseRequested: mock(async () => () => {}),
    };

    await runWindowAction("minimize", client);
    await runWindowAction("maximize", client);
    await runWindowAction("close", client);

    expect(client.minimize).toHaveBeenCalledTimes(1);
    expect(client.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("routes the top edge to native north resize dragging", async () => {
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      startResizeDragging: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
      subscribeCloseRequested: mock(async () => () => {}),
    };

    await runWindowResize("North", client);

    expect(client.startResizeDragging).toHaveBeenCalledWith("North");
  });

  test("forwards the selected application theme to the native window", async () => {
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      startResizeDragging: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
      subscribeCloseRequested: mock(async () => () => {}),
    };

    await client.setTheme("dark");
    await client.setTheme("light");

    expect(client.setTheme).toHaveBeenNthCalledWith(1, "dark");
    expect(client.setTheme).toHaveBeenNthCalledWith(2, "light");
  });

  test("lets the application confirm a close before invoking the adapter", async () => {
    const requestClose = mock(() => {});
    const client: WindowChromeClient = {
      minimize: mock(async () => {}),
      toggleMaximize: mock(async () => {}),
      startResizeDragging: mock(async () => {}),
      setTheme: mock(async () => {}),
      close: mock(async () => {}),
      subscribeCloseRequested: mock(async () => () => {}),
    };

    await runWindowAction("close", client, requestClose);

    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(0);
  });
});
