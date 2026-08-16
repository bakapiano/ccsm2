import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const vditorRoot = resolve(desktopRoot, "node_modules/vditor");
const katexFonts = readdirSync(resolve(vditorRoot, "dist/js/katex/fonts"))
  .filter((name) => name.endsWith(".woff2"))
  .sort()
  .map((name) => `dist/js/katex/fonts/${name}`);

const vditorRuntimeAssets = [
  "dist/css/content-theme/dark.css",
  "dist/css/content-theme/light.css",
  "dist/js/graphviz/full.render.js",
  "dist/js/graphviz/viz.js",
  "dist/js/highlight.js/highlight.min.js",
  "dist/js/highlight.js/third-languages.js",
  "dist/js/highlight.js/styles/github-dark.min.css",
  "dist/js/highlight.js/styles/github.min.css",
  "dist/js/icons/ant.js",
  "dist/js/i18n/en_US.js",
  "dist/js/katex/katex.min.css",
  "dist/js/katex/katex.min.js",
  "dist/js/katex/mhchem.min.js",
  ...katexFonts,
  "dist/js/lute/lute.min.js",
  "dist/js/mermaid/mermaid.min.js",
] as const;

function vditorAssets(): Plugin {
  const assetSet = new Set<string>(vditorRuntimeAssets);
  let outputDirectory = resolve(desktopRoot, "dist");

  return {
    name: "ccsm-vditor-assets",
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent(
          new URL(request.url ?? "/", "http://localhost").pathname,
        );
        const prefix = "/vendor/vditor/";
        if (!pathname.startsWith(prefix)) {
          next();
          return;
        }
        const asset = pathname.slice(prefix.length);
        if (!assetSet.has(asset)) {
          response.statusCode = 404;
          response.end("Vditor runtime asset is not bundled");
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType(asset));
        response.setHeader("Cache-Control", "no-store");
        createReadStream(resolve(vditorRoot, asset)).pipe(response);
      });
    },
    writeBundle() {
      for (const asset of vditorRuntimeAssets) {
        const destination = resolve(outputDirectory, "vendor/vditor", asset);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(vditorRoot, asset), destination);
      }
    },
  };
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export default defineConfig({
  clearScreen: false,
  plugins: [vditorAssets()],
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
  },
});
