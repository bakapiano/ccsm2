# 终端栈

生产终端以以下两个原型为实现来源：

- `prototypes/tauri-pty-ghostty-web-stateful`
- `prototypes/tauri-pty-dockview-child-webview`

前者定义终端行为，后者定义 Dockview 和 native browser 的组合方式。

## 锁定链路

```text
portable-pty platform backend
→ ordered raw byte channel
→ ghostty-web WASM Terminal
→ ghostty-web Canvas renderer
```

| 平台    | PTY backend                                                           | 当前状态                   |
| ------- | --------------------------------------------------------------------- | -------------------------- |
| Windows | Herdr-adapted portable-pty + verified app-local Microsoft ConPTY 1.24 | 当前实现与完整验收目标     |
| macOS   | portable-pty Unix PTY backend                                         | 保留接口，待原生构建和验收 |
| Linux   | portable-pty Unix PTY backend                                         | 保留接口，待原生构建和验收 |

## 所有权与约束

- ghostty-web 是唯一 VT、cursor、mode、viewport、selection 和 scrollback 所有者。
- Rust 管理 PTY/process、byte transport、resize 和 shutdown。
- PTY output 有序且只写入 ghostty-web 一次；input/query reply 原样回传。
- ghostty-web 是终端实现；ANSI 解析和兼容修复集中在其 WASM/TypeScript 层。
- 使用 vendored ghostty-web fork，保留 CJK spacer、单字符 selection、行边界 hysteresis、IME anchor 和 box drawing 修复。
- scrollback 使用 64 MiB byte budget。
- IME preedit 覆盖显示在 Canvas cursor 上；`compositionend` 将最终文本提交给 VT/PTY。

## Tab 集成

- 一个 writable runtime 同时只有一个 resize/input owner。
- inactive Tab 保留 ghostty-web 实例和 scroll position；follow-output 仅在 viewport 原本位于底部时生效。
- Dockview layout/resize后debounce fit，并把最终rows/cols发给AppBackend。
- 前端同一runtime同时只有一个resize command在途；resize burst只保留最新rows/cols。
- PTY input writer、resize worker和process waiter相互独立；底层resize停顿不阻塞input。短命进程退出时，reader先排空stdout/stderr；750ms上限保证孤立pipe无法阻塞Exit。
- 大段resume历史按动画帧限额批量写入ghostty-web，避免每个PTY chunk触发一次同步render。
- Runtime进入Exit后忽略同一runtime ID的迟到output，状态不能回退为live。
- Runtime注册完成前产生的PTY事件进入有序队列；快速Exit不能遗留幽灵runtime或覆盖最后一段错误输出。
- Session resume 等待首个稳定尺寸，再以该 rows/cols 创建 PTY 和启动 TUI。
- GUI进程生命周期内 ghostty-web持有完整 VT/scrollback。应用退出释放PTY和CLI process tree；下次启动根据Session desired state创建新runtime。

ConPTY DLL loading、Windows raw command tail 和 console resize 属于 `WindowsPtyBackend`；Unix fd、process group 和 signal 属于 macOS/Linux backend。ghostty-web byte contract 对三平台完全相同。

## Windows executable mode

- `ccsm-desktop.exe`使用Windows Console subsystem，使同一构建可作为ConPTY provider与Hook reporter运行。
- 桌面模式在启动后隐藏仅属于自身的console window；从现有Windows Terminal启动时保留父console。
- 每个agent runtime创建中性`ccsm-provider.exe`与`ccsm-hook.exe`硬链接。`CCSM_PROVIDER`选择Claude或Codex。
- 中性shim目录加入PATH。真实`codex`/`claude`名称保持可解析到`cxp`/`ccp`及其底层CLI。
- Provider、wrapper和真实CLI继承同一个ConPTY，所有stdin/stdout/stderr保持在CCSM Tab内。

## 依赖纪律

保留 portable-pty、Herdr patches、Windows ConPTY bundle、ghostty-web 及全部 license/NOTICE。ConPTY 只随 Windows artifact 分发；升级任一项必须先通过对应平台终端回归集。
