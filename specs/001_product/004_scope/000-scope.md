# 产品范围

## 当前产品

- Tauri 2 本地桌面应用。
- TypeScript/Dockview Tab UI。
- Tauri Rust主进程内的AppBackend。
- Space、Shell/Claude/Codex/Copilot CLI Session、Browser、File Explorer、Git 和内置 Tab Providers。
- Rust监管的TypeScript Agent Gateway、按需Node runtime和结构化Remote Web control。
- Windows 首发，同时保持 macOS/Linux platform adapters。

## 独立后续产品

Headless Gateway daemon、cloud relay和公网托管控制面作为独立版本设计。未来`ccsm-web-server`作为headless composition root复用`ccsm-core + ccsm-platform`。

## v2 删除项

- GitHub Pages hosted frontend、PWA 和版本 router。
- 旧版tunnel、远程terminal字节流和heartbeat watchdog实现。
- `ccsm://` wake flow、VBS launcher 和 Edge `--app` 启动链。
- Express HTTP API 和旧版浏览器localhost transport；Agent Gateway使用新的版本化Session API、pairing和sequenced event replay。
- 旧 Node 版 config/session/folder 数据导入和 schema 兼容。

v2 使用新的 application identity 和数据目录。旧版安装与数据保持独立。
