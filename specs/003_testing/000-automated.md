# 自动化测试架构

本文档定义可重复、无人值守、可进入GitHub Actions和发布门禁的自动化测试。具体功能用例与被验证代码共同维护。

开发者按需执行的`playwright-cli`、DevTools、人工交互和问题探索归入[Development Testing](001-development.md)。

## 运行结构

```text
Rust tests          cargo test --workspace
TypeScript tests    Vitest
Contract tests      Rust + TypeScript shared fixtures
Desktop tests       WDIO + @wdio/tauri-service
Packaging smoke     platform workflow scripts
        ↓
GitHub Actions OS/job matrix
        ↓
native job status + uploaded artifacts
```

各测试运行器直接发现和执行测试。GitHub Actions定义平台矩阵、执行顺序、secrets条件、超时和artifact保留策略。

测试系统遵循以下原则：

- 较低层验证纯逻辑和contract；较高层验证真实进程、OS和UI组合。
- 每个测试创建独立临时目录并清理自己启动的资源。
- 确定性fixture提供主回归证据；真实provider smoke补充兼容性证据。
- 测试失败保留日志、截图或状态副本，成功运行使用测试运行器的标准输出。
- 平台差异由GitHub Actions matrix和平台测试模块显式表达。

## 测试层次

| Layer          | 验证边界                                                               | 运行环境                     |
| -------------- | ---------------------------------------------------------------------- | ---------------------------- |
| L0 Static      | schema、types、format、license、dependency policy                      | compiler/linter              |
| L1 Unit        | reducer、parser、state machine、pure adapter logic                     | in-memory fixtures           |
| L2 Contract    | Rust/TypeScript protocol、storage、provider contracts                  | local component tests        |
| L3 Integration | AppBackend、platform adapters、PTY、filesystem、Git、process lifecycle | 真实本地进程和临时资源       |
| L4 Desktop     | Tauri host、主WebView、Dockview、native surface state、用户流程        | Tauri test build + WebDriver |

功能从最低可证明层开始验证。跨组件行为逐层上移，高层保留关键happy path和风险路径。

L0 dependency-boundary检查解析Cargo metadata：`ccsm-core`的依赖闭包中不得出现Tauri；`ccsm-core/ccsm-platform`源码执行forbidden-import检查，阻止BrowserSurface、window、WebView和renderer类型进入backend crates。TypeScript lint禁止desktop transport adapter之外的代码直接调用raw Tauri invoke/event API。

L2 storage schema snapshot验证runtime、ownership、resume mutex、cleanup queue和独立native binding table不会进入`data.db`，并验证`cli_sessions(provider, native_session_id)`的partial uniqueness。Schema test同时验证layout状态仅存在于`space_layouts`，全局window state仅存在于`settings`。L3并发resume测试验证同一native Session只spawn一次；restart测试验证RuntimeManager从空状态启动，并依据持久化`desired_state + native_session_id`执行恢复。

Cache schema test验证仅存在`git_repositories_cache`和`git_status_cache`，并确认scan generation不会跨进程持久化。

Hook integration tests覆盖认证成功、malformed payload、错误token、旧runtime ID和缺失Hook。缺失Hook场景验证CLI继续运行、退出后binding进入unavailable、重启不自动创建新provider Session，并确认没有provider directory扫描行为。

Agent activity tests覆盖Hook事件状态机、turn关闭后的迟到事件、PTY exit、跨Space Agent snapshot和增量事件。Desktop scenario点击左下Agent并验证Space、Tab和终端焦点同步切换；切换和分屏时验证当前Space内可见Agent的选中背景同步；关闭Agent CLI Tab时验证Panel在确认完成前保持挂载，取消后保留Tab与Session，确认后进程退出、Tab与Session从`data.db`删除且Agent条目消失；普通Shell Tab关闭不展示Agent警告。Browser overflow scenario从箭头菜单激活隐藏Browser Tab，并断言native surface bounds位于workspace header下方。

Browser occlusion tests验证capture、DOM截图解码、native hide、native show和截图释放的顺序；覆盖多个重叠浮层与capture期间快速关闭。Desktop scenario在Browser页面打开New Tab菜单、Tab右键菜单、overflow菜单和Modal，断言静态截图保持原画面且关闭后live页面继续运行。

Application dialog tests覆盖自定义文本输入、必填校验、危险操作、焦点、`Escape`取消，并扫描生产TypeScript以拒绝浏览器原生`alert`、`confirm`和`prompt`调用。

Space tree tests覆盖File Explorer风格的twistie、无前置图标的Space叶节点和22px行网格。Desktop scenario将Space拖入另一个Folder和Unfiled，验证drop target、committed `folder_id/folder_order`及重绘后的树位置。Sidebar layout tests覆盖Spaces/Agents separator的pointer、键盘、持久化与双侧最小高度。

File Editor tests固定CodeMirror 6与Vditor 3依赖边界，并验证Provider不重新引入自制textarea、高亮、搜索或history实现。Desktop scenario覆盖普通文本的CodeMirror DOM挂载、Unicode编辑、保存、Dirty关闭确认和Space切换后的EditorState保留；Markdown scenario覆盖Vditor IR挂载、编辑保存、代码高亮、KaTeX、Mermaid和Graphviz渲染。

Hang-resilience回归使用隔离Linux Tauri profile分阶段运行，并将每项指标写入JSON artifact：

- 1,200目录fixture验证host picker每页200行、快速导航取消，以及Explorer加载完整模型后DOM row window保持有界。
- 40,000行untracked TypeScript diff验证后端行数上限、按视口读取和diff DOM row window。
- `yes`连续PTY输出验证未确认bytes保持在512 KiB credit附近、renderer heartbeat推进，以及忽略TERM的process在3秒shared cleanup deadline内返回。
- 近5 MiB文件执行256次增量transaction，验证文档长度、renderer heartbeat和输入耗时。
- 持久化61个File Editor Tabs并冷启动，验证首屏mounted renderer与每帧materialization上限，再通过overflow菜单按需实例化目标Tab。

WDIO使用`prepare → setup → editor-tabs → recovery`四个独立应用生命周期；各阶段复用同一隔离`CCSM_DATA_DIR`并将截图、driver日志和`stress-*.json`写入`CCSM_E2E_ARTIFACT_DIR`。

L3 Space切换测试验证相同root复用ActiveRootContext、不同root关闭旧watcher并激活新context，同时确认inactive Space的CLI runtime和Hook继续运行。

L3 process lifecycle测试启动受application Job保护的owner与leaf进程，强杀owner并断言leaf在超时内退出。PTY lifecycle测试验证重复shutdown保持幂等，并在返回前完成process tree终止、线程join和PseudoConsole关闭。shim scavenger测试验证死亡PID目录被清理，活跃PID、符号链接和无关目录得到保留。L4退出场景检查WebView2、OpenConsole、CLI、Hook endpoint和watcher均不再持有进程或handle。

L4通过WebDriver操作主WebView DOM，并通过测试接口读取native surface的bounds、visibility、focus和lifecycle。真实系统输入法候选窗、硬件交互和人工视觉判断进入Development Testing。

## 命令入口

仓库提供稳定的顶层命令：

```text
test:static       L0 checks
test:rust         cargo test --workspace
test:frontend     Vitest run
test:contract     shared Rust/TypeScript contract checks
test:integration  L3 platform integration tests
test:desktop      WDIO desktop scenarios
test:all          current-platform L0-L4
```

命令可以由package scripts或仓库task runner实现，并向底层工具透传filter和日志级别。CI和本地开发调用同一入口。

## 跨语言Contract

Rust `ccsm-core`定义AppBackend DTO，`ccsm-desktop`定义Browser host DTO；两组model分别生成TypeScript types、JSON Schema和共享fixtures：

```text
crates/ccsm-core/src/dto/             backend Rust DTOs
crates/ccsm-desktop/src/browser/dto/  desktop host Rust DTOs
packages/protocol/generated/          generated TypeScript modules
protocol/schema/                      generated wire schemas
protocol/fixtures/                    shared golden vectors
```

CI重新生成artifacts，并通过clean diff验证生成结果与源码同步。

```text
L0  generated artifacts保持同步
L1  Rust/TypeScript codecs分别通过unit tests
L2  shared golden fixtures + bidirectional conformance
L3  Tauri adapter与真实AppBackend/platform/BrowserSurfaceManager集成
```

L2使用两个runner交叉验证真实encoder/decoder：

```text
TypeScript encode → Rust decode/re-encode → TypeScript assert
Rust encode → TypeScript decode/re-encode → Rust assert
```

Golden fixtures覆盖request、response、event、error、optional/null/missing field、unknown kind、Unicode/path和尺寸边界。Rust与TypeScript对同一fixture执行decode、normalize和encode。

PTY byte fixtures覆盖分段到达、合并到达、空payload、Unicode多字节边界和有序转发。Tauri commands/events/Channel使用生成DTO和相同byte fixtures。Browser host fixtures覆盖create/close/bounds/navigation/load failure。Future Web adapter仅复用core fixtures，并在实现时增加WebSocket framing、authentication和reconnect tests。

Desktop contract tests验证mutation command返回committed result且不发送镜像event。Async tests交错Start Session response与`live/exited/lost` event，验证同一runtime ID不会从后续状态回退到`starting`。Event tests覆盖subscribe-before-snapshot、加载期间buffering、幂等重复event和renderer reload后的完整snapshot恢复。

Filesystem contract tests验证`setWatchScope/clearWatchScope`仅管理监听范围，所有change hints作为`AppEvent`通过统一`DesktopEventStream`到达。

Runtime、Git scan和layout fixtures分别验证runtime ID不匹配、stale scan result和stale layout write会被拒绝。Rust exhaustive `match`与TypeScript discriminated union `assertNever`守住新增message kind的dispatch。

## TestContext

测试共享一个轻量`TestContext` helper：

```text
run_id
temporary data/cache/runtime paths
test Space root and provider home
spawned process handles
artifact directory
```

Rust通过RAII drop和显式async shutdown清理资源。TypeScript通过`afterEach/afterAll`执行对应cleanup。每个测试直接持有自己的TestContext。

TestContext提供以下基础操作：

- 创建隔离目录、IPC endpoint名称和测试ID。
- 启动并记录本测试创建的进程树。
- 将结构化日志、截图和数据库副本写入artifact目录。
- 在teardown中关闭WebViews、PTY、进程和临时文件。
- 为I/O失败、进程退出和时间控制提供局部test doubles。

领域fixture由普通builder或静态文件提供。领域测试直接选择所需fixture，无全局registry或manifest。

## Fixtures

```text
ProcessFixture       shell、CLI/provider、child tree、output behavior
FilesystemFixture    Space root、files、permissions、path shapes
RepositoryFixture    repository layout、markers、status state
BrowserFixture       navigation、storage、focus behavior
PersistenceFixture   Space/Tab/session/database snapshots
ProtocolFixture      requests、events、binary bytes、golden schemas
```

静态fixture保持immutable。每个测试将输入复制或materialize到自己的TestContext目录。fixture之间使用测试代码中的稳定logical IDs引用。

`data.db`为每个已发布Schema版本保留golden fixture。Data contract tests验证最新AppBackend能够打开、增量migration并读取所有旧fixture；Schema lint检查durable table/column语义、migration幂等性和`_cache` table重建。

确定性provider fixture用于PR回归。真实Claude/Codex/Copilot使用独立Credentialed Smoke workflow。

## Desktop自动化

Desktop tests使用[`@wdio/tauri-service`](https://v2.tauri.app/develop/tests/webdriver/)的embedded provider。测试构建启用`tauri-plugin-wdio-webdriver`；需要backend access、IPC mocking和日志捕获的测试启用`tauri-plugin-wdio`。

```text
TypeScript/Vite assets
→ Tauri test build
→ WDIO launch
→ DOM interaction + native-state assertions
```

每个scenario通过TestContext获得独立数据目录。native child WebView状态通过测试专用command查询；浏览器内容仍运行在其平台WebView中。

## GitHub Actions

GitHub Actions直接表达运行环境：

```text
windows-latest   Windows adapters + full current suite
macos-latest     implemented macOS adapters
ubuntu-latest    implemented Linux adapters + virtual display
self-hosted      signing、IME、受保护provider或硬件场景
```

同一runner上冲突的display、provider account和platform singleton使用job串行化或GitHub concurrency group。测试进程内部的并行度由Cargo、Vitest和WDIO原生配置控制。

每个job设置独立data/cache/runtime目录。外部provider credentials通过GitHub secrets引用，运行数据进入隔离provider home。

## Release automation

```text
Packaging Smoke      build/install/start/stop/uninstall artifact
Platform Smoke       PTY、WebView runtime、filesystem、process integration
Credentialed Smoke   非交互认证的真实Claude/Codex/Copilot启动与resume
```

Packaging和Platform Smoke可在GitHub-hosted或self-hosted runner无人值守执行。Credentialed Smoke使用受保护secrets、额度和runner，并与确定性测试结果分开显示。

## 可观测性

AppBackend、renderer、Hook、PTY和Git日志传播`run_id、resource_id`，并在相关领域附带runtime ID、scan generation或layout revision。测试失败时上传相关结构化日志、WebDriver截图、DOM snapshot和必要的数据库副本。

artifact使用GitHub Actions原生上传和保留策略。credential、token和provider transcript在写入artifact前redact。

## 门禁

```text
Local Gate     affected L0-L2
PR Gate        affected L0-L3 + current-platform smoke
Main Gate      desktop + recovery/security tests
Nightly Gate   stress + credentialed smoke + extended OS matrix
Release Gate   L0-L4 + required release automation
```

workflow通过path filters和显式job dependencies选择测试。GitHub Actions的passed、failed、cancelled和skipped状态作为门禁事实源。

Windows首先覆盖完整门禁。macOS/Linux随着adapter完成度加入相同层次；缺失的实现通过明确的未启用job记录在平台计划中。

## 测试归属

```text
Rust unit/contract       next to crate/module or crate tests/
TypeScript unit          next to source module
Protocol golden          shared protocol package
Runtime integration      integration tests grouped by domain
Desktop scenarios        desktop tests grouped by product flow
Release automation       platform adapter/package test area
```

产品规格定义用户可观察结果。技术规格定义invariants和contracts。测试名称或注释引用对应Spec ID。

领域重构同时移动其测试。共享TestContext保持轻量，并通过真实测试需求逐步扩展。
