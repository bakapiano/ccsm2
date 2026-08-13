# Development Testing

Development Testing 为开发阶段提供按需、交互式、探索性的验证。它帮助复现问题、观察内部状态和快速确认修复方向。

这类运行由开发者主动发起，结果用于诊断。稳定且重复出现的场景会转化为自动化测试，并进入 [Automated Testing](000-automated.md) 的对应 Layer。

## 与自动化测试的边界

|          | Development Testing    | Automated Testing                   |
| -------- | ---------------------- | ----------------------------------- |
| 发起者   | 开发者按需启动         | Gate/CI 调度                        |
| 操作方式 | 交互、探索、可调整步骤 | 固定测试命令与断言                  |
| 环境     | 当前开发机器和目标设备 | GitHub Actions平台job或本地隔离环境 |
| 结果     | 诊断结论与复现材料     | 测试运行器状态与artifacts           |
| 门禁     | 独立人工记录           | Local/PR/Main/Nightly/Release Gate  |

开发测试可以使用真实用户交互和视觉判断。自动化测试使用确定性 assertions 和可重复 fixtures。

## Desktop hot-reload loop

日常桌面开发从repository root运行：

```powershell
pnpm dev
```

命令链固定为`root dev → desktop:dev → @ccsm/desktop dev:desktop → tauri dev`。Tauri通过`beforeDevCommand`启动`@ccsm/desktop dev`的Vite server，并让主WebView加载`devUrl`。

- `apps/desktop/src`中的TypeScript和CSS修改使用Vite HMR更新现有桌面窗口，不重启Rust host、PTY、CLI process tree或native Browser surface。
- `apps/desktop/src-tauri`或Rust crate修改由Tauri dev触发native重新编译；需要重启host时按native lifecycle处理，不能假设runtime与WebView状态跨重启保留。
- `pnpm desktop:build:debug`生成内嵌`dist`的debug executable，用于最终build验证，不提供HMR，也不作为普通前端迭代入口。
- 同一workspace保持一个Tauri dev实例。固定Vite/CDP端口、Browser profile和测试data directory不得被重复实例争用。
- 交互验证优先使用小范围locator、targeted eval和隔离fixture。完整accessibility tree或大范围snapshot不得对用户长期运行的实例执行。

## 适用场景

- 新功能首次接入，自动化 contract 尚未稳定。
- UI geometry、focus、selection、IME、native child WebView 等视觉或交互问题。
- AppBackend/PTY/Hook/Git watcher 的竞态复现。
- GitHub Actions 失败后的本地诊断。
- 真实 Claude/Codex/Copilot 长 Session 的探索性 smoke。
- 特定操作系统、显示器、输入法和用户配置组合。
- Release 前的人工视觉、真实输入法候选窗、硬件和系统集成 sign-off。

## 工具

```text
playwright-cli     按需连接 Windows WebView2 CDP
WebView DevTools   DOM、Canvas、network、performance
Rust debugger      AppBackend、process、Tauri adapter、state
structured logs    run/resource和领域竞态标记关联
SQLite tools       Space、Tab、Session 和 cache inspection
OS tools           process tree、PTY、window、filesystem watcher
```

`playwright-cli` 用于开发者交互式验证：snapshot、eval、keyboard、mouse、screenshot 和多 WebView观察。命名会话在工作结束时detach，进程清理使用本次运行记录的PID和sandbox路径。

重复执行的 Desktop Scenario 使用 `@wdio/tauri-service` 自动化，并进入 L4 Suite。

## WSL Ubuntu/WSLg Linux desktop bring-up

Windows开发机可以使用WSL2与WSLg完成Linux adapter的首轮编译、GUI和真实provider验收。WSL运行结果属于Linux Development Testing；Ubuntu真机或VM继续承担GNOME Wayland/Xorg、安装包和系统生命周期的发布验收。

环境准备遵循以下约束：

- 使用具名Ubuntu LTS发行版和普通sudo用户。记录`wsl --version`、`/etc/os-release`、`DISPLAY`、`WAYLAND_DISPLAY`与`XDG_RUNTIME_DIR`。
- repository可以在独立的Windows D盘clone中维护；Cargo target、测试data directory和provider临时状态位于WSL ext4用户目录。Windows与Linux不得复用`node_modules`。
- Tauri构建依赖至少包含`libwebkit2gtk-4.1-dev`、`libxdo-dev`、`libssl-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`build-essential`、`pkg-config`和`file`。
- Node、pnpm、Bun和Rust版本与repository声明及主开发机保持一致。Claude、Codex与GitHub Copilot安装Linux CLI；所需认证从本机用户配置迁移到WSL用户目录，credential、token、history、transcript和provider session database不得进入repository或artifact。
- Windows本机provider配置若引用loopback proxy，WSL NAT通过`ip route`的default gateway访问Windows host。WSL专用配置仅替换loopback host并保持scheme、port、path、model和credential不变；每轮启动前验证对应TCP endpoint可达。
- Provider配置目录保持用户私有：directory使用`0700`、file使用`0600`。不得对目录递归应用file mode；Claude `projects/`缺少execute位会导致transcript写入EACCES并使resume找不到native Session。

首次基线运行：

```bash
cd /mnt/d/ccsmv2-linux
export CARGO_TARGET_DIR="$HOME/.cache/ccsm-target"
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dev
```

WSLg窗口首先验证Shell PTY、Files、Git和WebKitGTK Browser。Browser child surface同时记录renderer DOM bounds、Tauri主窗口scale factor和native child bounds；页面内容必须完全位于Browser Tab viewport内，并在移动、缩放、split和DPI变化后继续对齐。

Tauri 2.11的Linux `WindowChild`路径将额外WebView加入默认`GtkBox`；GtkBox会扩展child并忽略任意矩形位置。CCSM Linux adapter在首个Browser创建时将主WebView与Browser children迁入同一个`GtkFixed`，主WebView跟随host allocation填满窗口，Browser child由CSS logical bounds设置GTK position与allocation。该平台修复由geometry artifact和合成窗口截图共同验收。

Browser overlay使用WebKitGTK visible-region snapshot生成PNG。New Tab菜单、Tab context menu、overflow与modal打开前先显示该PNG并隐藏native child；overlay关闭后恢复live WebView并释放DOM snapshot。

### Linux WebDriver bridge

Linux GUI自动化使用`tauri-driver + WebKitWebDriver`连接真实Tauri主WebView；Ubuntu安装`webkit2gtk-driver`并通过`cargo install tauri-driver --locked`提供桥。测试配置在`onPrepare/onComplete`中管理driver进程，应用由WebDriver capabilities启动。普通dev/release构建不包含或监听测试server。

```bash
export CARGO_TARGET_DIR="$HOME/.cache/ccsm-target"
pnpm desktop:build:debug

export CCSM_E2E_APP_BINARY="$CARGO_TARGET_DIR/debug/ccsm-desktop"
export CCSM_E2E_ARTIFACT_DIR=/absolute/path/to/linux-desktop-artifacts
export CCSM_DATA_DIR="$HOME/.local/share/ccsm-linux-e2e"
pnpm --filter @ccsm/desktop test:desktop:linux

# 在本地认证环境中额外执行真实provider turn/resume
export CCSM_E2E_REAL_PROVIDERS=1
# 调试时可指定逗号分隔的provider子集
export CCSM_E2E_PROVIDERS=claude,codex,copilot
# provider单项调试可复用已通过的Browser gate
export CCSM_E2E_SKIP_BROWSER=1
pnpm --filter @ccsm/desktop test:desktop:linux

# 独立验证desktop SIGKILL后的runtime group、watchdog与WebKit子进程回收
export CCSM_E2E_REAL_PROVIDERS=0
export CCSM_E2E_ABNORMAL_EXIT=1
export CCSM_E2E_SKIP_BROWSER=1
pnpm --filter @ccsm/desktop test:desktop:linux
```

WebDriver使用内嵌frontend的Tauri debug binary。Rust修改后通过`pnpm desktop:build:debug`重建；裸`cargo build`会按debug `devUrl`生成依赖Vite 1421端口的可执行文件，不能作为独立WebDriver test binary。

WDIO Linux配置直接启动`tauri-driver`、系统`WebKitWebDriver`与应用。桥接验收至少读取`#app`、点击`.dock-new-tab-button`、观察`#new-tab-menu`、操作terminal canvas并生成WebDriver screenshot。native Browser child由WebKitGTK snapshot和WSLg合成窗口截图补充证明。embedded provider若无法枚举Tauri主窗口，诊断结果记录在PR evidence中，不作为Linux bridge依赖。

Ubuntu `WebKitWebDriver`会在已建立自动化session后动态新增第二个native WebView时终止；自动化Browser场景复用启动布局中的Browser。多Browser创建与关闭使用普通WSLg GUI smoke和Rust GTK adapter回归验证，并单独记录系统driver限制。

### Credentialed GUI acceptance

真实provider smoke在隔离Space和data directory中顺序执行，避免account、display、port和resume state竞争：

1. 从New Tab菜单创建Claude、Codex和GitHub Copilot Tab。
2. 每个Tab在terminal canvas输入唯一验收消息，等待可见回复，并保存包含Tab标题、消息与回复的GUI截图。
3. 记录Hook认证产生的native Session ID，关闭并重新启动对应runtime，验证同一Session resume；保存resume后的连续对话截图与数据库/Hook证据。
4. Browser导航到稳定HTTPS页面，验证标题、URL、页面内容、focus、reload、native bounds与overlay snapshot；保存正常页面和overlay两张截图。
5. 正常Stop、关闭Tab、关闭应用和强杀desktop四条路径分别记录`ps/pstree`前后结果。desktop、provider CLI、provider child、Hook socket、runtime shim和WebKit子进程均不得在清理超时后残留。
6. 补充Space切换、窗口resize、Browser与CLI分屏、file watcher、Git刷新、中文输入和应用重启后的layout恢复。

PR description逐项链接GUI截图和文本证据。截图只包含本次隔离测试窗口；进程树、SQLite查询和Hook日志在写入artifact前移除token、credential、用户transcript与无关桌面内容。

Unix PTY runtime由portable-pty `setsid()`建立独立process group。正常Stop按`SIGTERM`等待后升级`SIGKILL`；desktop为每个runtime启动control-pipe watchdog，desktop异常退出时pipe EOF触发watchdog清理整个process group。资源证据同时记录PID、PPID、PGID与SID。

Ubuntu release archive在Ubuntu/WSL内通过`pnpm package:ubuntu`生成。包内包含release binary、启动脚本、runtime依赖说明、source revision、binary SHA-256、许可证与第三方声明；验收从解压目录启动该binary并复用上述WebDriver bridge。最终archive与旁置SHA-256文件共同进入PR可下载artifact。

Linux PR gate至少包含以下无凭据回归：Gtk logical bounds到allocation的取整、Unix executable PATH解析、死亡PID shim root清理、process-group termination，以及WebDriver bridge菜单/Browser geometry场景。真实provider测试作为credentialed Development/Release evidence独立记录。

## 工作流

```text
create isolated dev sandbox
→ start or reuse `pnpm dev` hot-reload desktop
→ attach debugger or playwright-cli
→ reproduce and inspect
→ verify candidate change
→ capture useful artifacts
→ detach and clean owned resources
→ add/update automated regression
→ run `pnpm desktop:build:debug` before handoff
```

## 隔离

- 开发测试使用独立 data/cache/runtime directories 和 Space root。
- provider smoke 使用专用 fixture folder 和明确的 provider home。
- Browser profile、IPC endpoint、CDP port 和 artifacts 归属本次 dev run。
- 真实用户 Space、repository 和 provider transcript 保持原样。

## 输出

一次有价值的 Development Testing 应留下以下一种或多种结果：

- 可复现步骤和最小 fixture。
- event journal、日志、截图或 trace。
- 已确认的 ownership/state transition。
- 新增的 L1/L2/L3/L4 自动化回归。
- 明确记录的平台或环境限制。

## 自动化转化

满足以下任一条件时，将开发验证转成自动化回归：

- 问题曾导致 crash、data loss、错误 resume 或资源泄漏。
- 同一路径需要在多个平台重复验证。
- 修复依赖明确的 state transition、protocol event 或 geometry invariant。
- 手工步骤在两个以上开发周期重复出现。
- 该行为进入 PR 或 Release Gate 的验收范围。

优先选择最低可证明 Layer：纯逻辑进入 L1，跨语言边界进入 L2，真实进程进入 L3，完整桌面流程进入 L4。

Development Testing 本身不作为 PR 的无人值守 Gate。Release 所需证据由自动化 Suites 和明确的人工/硬件 sign-off 分别记录。
