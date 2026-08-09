# 跨平台能力

目标平台是 Windows、macOS、Linux。Windows-first 表示实现和验收顺序；领域模型、数据库和 IPC message 采用共享定义。

## Platform adapters

```text
PtyBackend             PTY create/read/write/resize
ProcessTree            interrupt/terminate/kill
CliShimAdapter         PATH shim、binary resolution、quoting
PlatformPaths          data/cache/runtime directories
FileWatchAdapter       Space folder/Git filesystem events
```

核心 Session、Tab、Hook binding、进程内runtime coordination和persistence通过这些接口访问平台能力。

Native browser平台实现位于ccsm-desktop：Windows模块封装WebView2，macOS模块封装WKWebView，Linux模块封装WebKitGTK。共享的`BrowserSurfaceManager`和TypeScript contract位于desktop边界。

Installer、package format、signing和notarization由Tauri bundle config与GitHub Actions platform workflows定义。首版runtime不包含应用内updater。

## 能力矩阵

| 能力            | Windows（当前重点）                      | macOS                                    | Linux                                                 |
| --------------- | ---------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| PTY             | app-local ConPTY 1.24                    | Unix PTY                                 | Unix PTY                                              |
| Hook endpoint   | Named Pipe                               | Unix domain socket                       | Unix domain socket                                    |
| 进程树          | application Job + nested runtime Job     | planned：process group + watchdog        | planned：process group + parent-death signal/watchdog |
| CLI shim        | 中性console `.exe`，处理 `.cmd/.bat`     | executable/symlink                       | executable/symlink                                    |
| Browser         | WebView2                                 | WKWebView                                | WebKitGTK                                             |
| Browser runtime | 系统 WebView2 Runtime                    | 系统 WKWebView                           | 系统 WebKitGTK 包                                     |
| 文件监听        | Windows filesystem notifications         | FSEvents/kqueue adapter                  | inotify adapter                                       |
| 数据目录        | LocalAppData                             | Application Support                      | XDG data/state                                        |
| 路径            | drive、UNC、默认大小写不敏感             | POSIX、通常大小写不敏感但不可假设        | POSIX、通常大小写敏感                                 |
| GUI 自动化      | `@wdio/tauri-service` embedded WebDriver | `@wdio/tauri-service` embedded WebDriver | `@wdio/tauri-service` embedded WebDriver              |
| 发布包          | `.exe` + Windows installer               | signed/notarized `.app`/DMG              | AppImage/deb/rpm 之一或多种                           |

## Windows-specific modules

以下实现按层归属Windows模块：

- ccsm-platform：vendored Microsoft ConPTY DLL、hash loader和raw Windows command tail patch。
- ccsm-platform：`.exe/.cmd/.bat` CLI查找、Windows quoting、HookEndpoint Named Pipe、process creation flags和Job Object。
- ccsm-platform：application Job在异常退出时回收WebView2、OpenConsole和CLI树；runtime Job执行单Session Stop。
- ccsm-platform：中性provider/Hook shim、PTY output-before-exit ordering和快速启动事件队列。
- ccsm-desktop：WebView2 child surfaces、CDP、profile和Windows IME集成。
- ccsm-desktop：Console subsystem桌面入口与独立console window隐藏策略。
- delivery workflow：Tauri bundle config、Windows installer、code signing和artifact upload。

macOS/Linux 分别生成自己的签名、安装和更新 artifact；三平台共享 Space 数据 schema。

## 共享层规则

- 使用 `PathBuf`/URL 和 `PlatformPaths` 生成路径。
- `runtime_id`关联Hook、PTY和exit事件；platform adapter持有真实process handle、Job Object或process group。PID仅作为平台实现数据。
- 数据 schema、Tab state 和 protocol bytes 在三平台一致。
- 首版 Shell/Claude/Codex 命令来自 built-in provider definitions 和 platform resolver；自定义 CLI配置后置。
- 后端OS条件编译集中在ccsm-platform；native browser条件编译集中在ccsm-desktop/browser。Session/Tab业务逻辑使用共享接口。
- 平台通过真实 PTY、Hook、WebView、IME 和 packaging smoke 后标为 supported；其余阶段标为 planned/experimental。
