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
- ghostty-web在CLI启用DEC mouse tracking时发送SGR 1006 mouse press、release、motion和wheel序列；未启用SGR格式时回落X10编码。已识别链接的hover和普通左键点击由CCSM保留，不发送给PTY；非链接区域继续遵循应用mouse mode。链接hover使用位于cell内部的可见下划线。
- Rust 管理 PTY/process、byte transport、resize 和 shutdown。
- PTY output 有序且只写入 ghostty-web 一次；input/query reply 原样回传。
- Runtime output进入容量为64的有界事件channel，并受512 KiB byte-credit gate约束。前端在ghostty-web完成对应write callback后按byte数确认消费；丢弃、捕获和清理路径同样归还credit。Runtime stop与shutdown关闭gate并唤醒等待中的reader。
- 前端fit、resize和每批最多8 KiB的output消费通过animation-frame scheduler执行；WebView暂停animation frame时由100ms watchdog推进同一个有界slice。等待绘制完成的异步路径使用相同的100ms上限继续检查状态。
- ghostty-web 是终端实现；ANSI 解析和兼容修复集中在其 WASM/TypeScript 层。
- 使用 vendored ghostty-web fork，保留 CJK spacer、单字符 selection、行边界 hysteresis、IME anchor 和 box drawing 修复。
- Box-drawing的整格水平线与垂直线使用单个连续Canvas shape，cell中心和边界不产生重复alpha接缝。
- scrollback 使用 64 MiB byte budget。
- IME preedit 覆盖显示在 Canvas cursor 上；`compositionend` 将最终文本提交给 VT/PTY。
- IME input proxy和preedit overlay使用Terminal host内的Canvas布局坐标；Dockview transform不能重复叠加Panel viewport偏移。
- 新GhosttyTerminal handle在首次viewport读取和render前执行RIS；WASM allocator复用的已释放screen cells不能出现在新Tab首帧。
- ghostty-web跟踪应用通过CSI协商的Kitty keyboard flags栈与xterm modifyOtherKeys状态，并在每次按键编码前同步DECCKM、DECNKM、NumLock、Alt ESC prefix和增强键盘状态；修饰后的Enter与文本键保持独立序列，不能退化为无修饰键输入。

## Tab 集成

- 一个 writable runtime 同时只有一个 resize/input owner。
- inactive Tab 保留 ghostty-web 实例和 scroll position；follow-output 仅在 viewport 原本位于底部时生效。
- Claude/Codex的`onKey`、paste和`compositionend`用户输入在写入PTY前调用`scrollToBottom`，显式恢复follow-output；终端生成的query reply和普通PTY output不改变用户控制的历史viewport。
- Dockview layout/resize使用trailing debounce合并连续几何变化；pointer resize手势期间保留并裁剪最后一个完整Canvas帧，手势结束后复制该帧为只读覆盖层，在背后只按最终rows/cols完成live Canvas fit、PTY resize与Claude原子repaint，全部提交后一次性移除覆盖层；首次显示和Space切换立即fit。
- 原生窗口最小化产生的WebView临时小viewport不参与terminal fit或PTY resize；恢复到可渲染viewport后强制完整Canvas redraw，并仅在稳定几何变化时执行一次最终fit/repaint。
- 前端同一runtime同时只有一个resize command在途；resize burst只保留最新rows/cols。
- bound Claude发生列宽变化时，先仅临时扩展PTY行数以触发Claude按新列宽完整重绘；前端只有在验证Claude清除了完整临时viewport、返回了从welcome开始的完整repaint且terminal仍为目标尺寸后，才原子替换ghostty VT/scrollback、按比例恢复历史滚动位置并恢复真实行数。验证后的repaint收到synchronized-output结束序列`CSI ?2026l`，或以Claude最终水平/垂直cursor定位对结束时立即提交；缺少明确结束边界时使用400ms output quiet fallback。超时、超限、过期尺寸或不完整repaint不得清除既有历史，退回普通resize/reflow。
- Codex与Copilot发生最终PTY resize时保留frame覆盖层；synchronized-output结束序列作为batch候选边界，其后的PTY output继续合并，直到最后一个batch后连续200ms没有新output且ghostty output queue已经排空；连续输出最多等待1s，随后揭开当前live Canvas。中间reflow和未排空chunks不得直接呈现。
- PTY input writer、resize worker和process waiter相互独立；底层resize停顿不阻塞input。短命进程退出时，reader先排空stdout/stderr；750ms上限保证孤立pipe无法阻塞Exit。
- 大段resume历史按动画帧限额批量写入ghostty-web，避免每个PTY chunk触发一次同步render。
- Runtime进入Exit后忽略同一runtime ID的迟到output，状态不能回退为live。
- Runtime注册完成前产生的PTY事件进入有序队列；快速Exit不能遗留幽灵runtime或覆盖最后一段错误输出。
- Session resume 等待首个稳定尺寸，再以该 rows/cols 创建 PTY 和启动 TUI。
- GUI进程生命周期内 ghostty-web持有完整 VT/scrollback。应用退出释放PTY和CLI process tree；下次启动根据Session desired state创建新runtime。
- 每个retained Terminal renderer持有独立Ghostty WASM实例；WASM module下载可缓存，allocator和RenderState arena不跨Tab共享，关闭后新建Tab不能观察已释放VT的cells。
- CLI Provider兼容层将Codex的`Shift+Enter`和`Ctrl+Enter`映射为其已支持的legacy `Alt+Enter`（`ESC CR`）multiline input；不得发送未协商的CSI-u序列，否则可打印后缀会进入prompt。终端输入回归集同时验证协商后的通用modified Enter、Claude所需的`Shift+Enter`不退化为CR，以及默认DEC Alt ESC prefix下`Alt+V`产生`ESC v`。
- Agent CLI Provider层消费`Ctrl/Cmd+C`并复制SelectionManager选区；该组合键不进入Ghostty key encoder，不向Agent PTY发送`0x03`。Shell Provider继续由Ghostty key encoder生成ETX。
- ghostty-web LinkProvider在VT buffer完成ANSI解析后识别普通URL、OSC 8 URL和文件引用。HTTP/HTTPS/`about:`交给CCSM创建内置Browser Tab；文件引用先由platform adapter canonicalize并验证Space containment，再创建或聚焦File Editor Tab。链接路由不改写PTY byte stream。

ConPTY DLL loading、Windows raw command tail 和 console resize 属于 `WindowsPtyBackend`；Unix fd、process group 和 signal 属于 macOS/Linux backend。ghostty-web byte contract 对三平台完全相同。

## Windows executable mode

- `ccsm-desktop.exe`使用Windows Console subsystem，使同一构建可作为ConPTY provider与Hook reporter运行。
- 桌面模式在启动后通过`FreeConsole`解除仅属于自身的console；从现有Windows Terminal启动时保留父console。
- 每个agent runtime创建中性`ccsm-provider.exe`与`ccsm-hook.exe`硬链接。`CCSM_PROVIDER`选择Claude、Codex或Copilot。
- 中性shim目录加入PATH。Provider resolver在shim目录之外解析原生`codex`、`claude`和`copilot`命令。
- Provider、wrapper和真实CLI继承同一个ConPTY，所有stdin/stdout/stderr保持在CCSM Tab内。

## 依赖纪律

保留 portable-pty、Herdr patches、Windows ConPTY bundle、ghostty-web 及全部 license/NOTICE。ConPTY 只随 Windows artifact 分发；升级任一项必须先通过对应平台终端回归集。
