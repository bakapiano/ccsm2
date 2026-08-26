import { CcsmApp } from "./app";
import { LinkOpeningController } from "./link-opening";
import "./style.css";
import { applyDocumentTheme, ThemeController } from "./theme";

if (import.meta.env.MODE === "e2e") {
  await import("@wdio/tauri-plugin");
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app root");

const theme = new ThemeController(window.localStorage, applyDocumentTheme);
const linkOpening = new LinkOpeningController(window.localStorage);
const app = new CcsmApp(root, theme, linkOpening);

declare global {
  interface Window {
    __CCSM_DEBUG__: {
      app: CcsmApp;
      snapshot: () => object;
    };
  }
}

window.__CCSM_DEBUG__ = {
  app,
  snapshot: () => app.snapshot(),
};

void app.start();
