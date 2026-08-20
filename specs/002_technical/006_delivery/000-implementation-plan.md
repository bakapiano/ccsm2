# 实施计划

CCSM v2 使用独立代码路径和新数据目录。开发采用纵向切片，每个 Phase 交付可运行结果。

每个 Phase 的完成条件由 [自动化测试架构](../../003_testing/000-automated.md) 中对应的 unit、integration、desktop 和 recovery gate 验证。

## Phase 0：Space shell

- 新建Tauri workspace、TypeScript strict配置和生成DTO types。
- 实现 Space store、Tab registry、Dockview layout save/restore。
- 实现虚拟Space Folder Tree、nested drag/drop、串行tree mutations和layout revision persistence。
- 建立`ccsm-core / ccsm-platform / ccsm-desktop` crates，并在core/platform边界定义`PtyBackend`、`ProcessTree`、`CliShimAdapter`、`PlatformPaths`和`FileWatchAdapter`。core保持Tauri-free。

完成条件：混合 mock Tabs 的 split、drag、switch Space 和 crash restore 可重复通过。

## Phase 1：Rust AppBackend + 终端

- 从终端原型纳入 ghostty-web、portable-pty patches、Windows ConPTY bundle 和测试。
- 在Tauri Rust主进程构造AppBackend，实现storage、create/attach/input/resize/stop和持续PTY drain。
- 实现幂等shutdown、process-tree cleanup和平台process containment。
- CLI Tab 接入真实 platform shell、Claude Code、Codex 和 GitHub Copilot runtime。

完成条件：真实CLI输入、resize和退出cleanup通过，下一次启动按desired state恢复Session。

## Phase 2：CLI Session + Hook

- 实现持久Session/native ID与进程内runtime分层。
- 实现Claude/Codex/Copilot per-launch wrapper、Hook-only native binding、missing-Hook状态、opaque runtime ID与keyed resume mutex。
- 将 CLI Tab 的恢复接入 attach-or-resume 流程。

完成条件：新建、resume、fork/ID rotation 绑定正确 ID，重复 resume 合并为一次启动。

## Phase 3：完整 Space

- 在ccsm-desktop接入`BrowserSurfaceManager`、global Browser Profile和三平台native child WebView实现。
- 接入只读 Space-scoped File Explorer 和 Git tree。
- 接入只读 Git Tab 和多 repository status sections。
- 接入编译期Tab Provider Registry和各Provider的versioned Tab state。
- 完成各 Tab 的 degraded/failed/Retry 恢复体验和增量 Git discovery。

完成条件：Space 混合布局在正常退出、GUI crash 和 runtime loss 三种路径下恢复。

## Phase 4：平台与发布

- Windows 完整实现、NSIS安装包和应用内升级首先通过验收。
- macOS/Linux adapters 接入 Unix PTY/socket/process-group 和原生 WebView。
- Linux交付`.deb`与AppImage，并接入与Windows共享的检查、签名验证和升级界面。
- 三个平台共享领域 API、数据库 schema 和 protocol types。

完成条件：对应平台通过真实 PTY、Hook、Browser、IME、Space recovery、packaging smoke 和候选安装包升级smoke后标记 supported。
