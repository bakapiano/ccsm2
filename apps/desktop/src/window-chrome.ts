import type { WindowChromeClient } from "./transport/desktop-client";

type WindowAction = "minimize" | "maximize" | "close";

export function runWindowAction(
  action: WindowAction,
  client: WindowChromeClient,
  requestClose?: () => void,
): Promise<void> {
  if (action === "minimize") return client.minimize();
  if (action === "maximize") return client.toggleMaximize();
  if (requestClose) {
    requestClose();
    return Promise.resolve();
  }
  return client.close();
}

export function bindWindowChrome(
  root: HTMLElement,
  client: WindowChromeClient,
  requestClose?: () => void,
): void {
  root
    .querySelectorAll<HTMLButtonElement>("[data-window-action]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.windowAction as WindowAction | undefined;
        if (action) void runWindowAction(action, client, requestClose);
      });
    });

  root.querySelector(".app-titlebar")?.addEventListener("dblclick", (event) => {
    if ((event.target as Element | null)?.closest("button, input")) return;
    void client.toggleMaximize();
  });
}
