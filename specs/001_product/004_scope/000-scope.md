# 产品范围

## 当前产品

- Tauri 2 本地桌面应用。
- TypeScript/Dockview Tab UI。
- Tauri Rust主进程内的AppBackend。
- Space、Shell/Claude/Codex CLI Session、Browser、File Explorer、Git 和内置 Tab Providers。
- Windows 首发，同时保持 macOS/Linux platform adapters。

## 独立后续产品

Web frontend、WebSocket server、远程设备和cloud relay作为独立版本设计。独立Web frontend通过`ccsm-web-server`复用`ccsm-core + ccsm-platform`。

## v2 删除项

- GitHub Pages hosted frontend、PWA 和版本 router。
- tunnel、remote device、pairing、heartbeat watchdog 和远程 terminal transport。
- `ccsm://` wake flow、VBS launcher 和 Edge `--app` 启动链。
- Express HTTP API 和旧版浏览器 localhost transport。
- 旧 Node 版 config/session/folder 数据导入和 schema 兼容。

v2 使用新的 application identity 和数据目录。旧版安装与数据保持独立。
