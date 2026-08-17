import { CcsmApp } from "./app";
import "./style.css";
import { applyDocumentTheme, ThemeController } from "./theme";
import { RendererHealthController } from "./renderer-health";
import { desktopClient } from "./transport/desktop-client";

if (import.meta.env.MODE === "e2e") {
  await import("@wdio/tauri-plugin");
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app root");

const theme = new ThemeController(window.localStorage, applyDocumentTheme);
const app = new CcsmApp(root, theme);
const rendererHealth = new RendererHealthController(
  desktopClient.rendererHealth,
  () => app.rendererHealthSnapshot(),
  (response) => app.showRendererRecoveryNotice(response),
);

declare global {
  interface Window {
    __CCSM_DEBUG__: {
      app: CcsmApp;
      snapshot: () => object;
      rendererHealth: {
        setAckSuppressed: (suppressed: boolean) => void;
        simulateClick: () => Promise<number>;
        snapshot: () => Promise<object>;
      };
    };
  }
}

window.__CCSM_DEBUG__ = {
  app,
  snapshot: () => app.snapshot(),
  rendererHealth: {
    setAckSuppressed: (suppressed) =>
      rendererHealth.setAckSuppressed(suppressed),
    simulateClick: () => rendererHealth.debugSimulateClick(),
    snapshot: () => rendererHealth.debugSnapshot(),
  },
};

void (async () => {
  try {
    await rendererHealth.install();
  } catch (error) {
    console.error("renderer health install failed", error);
  }
  await app.start();
  try {
    await rendererHealth.markReady();
  } catch (error) {
    console.error("renderer health ready failed", error);
  }
})();

window.addEventListener("beforeunload", () => rendererHealth.dispose());
