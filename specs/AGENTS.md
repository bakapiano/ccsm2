# CCSM v2 specifications

本目录是 CCSM v2 的事实源。产品行为位于 `001_product/`，实现细节位于 `002_technical/`，测试规格位于 `003_testing/`。实现前先读根 `README.md` 和对应目录索引。

- 已锁定的技术决策通过规格变更调整，并同时说明实施与数据影响。
- 文档保持短小，内容聚焦职责、接口、不变量和验收条件。
- `prototypes/` 提供可复制的已验证实现；生产代码将所需源码和资产纳入自己的构建边界。
- v2 采用 greenfield 实现；旧 Node 产品作为行为参考，v2 数据和协议不承担兼容或迁移。
- 新增规格必须加入 `README.md` 索引，并避免与现有文档重复定义同一个所有者。
- 产品文档描述用户概念、行为和范围；技术文档描述数据结构、协议、算法和平台 adapter；测试文档描述测试分层、harness、fixture system、环境、可观测性和门禁架构。
- 测试规格分为 Automated Testing 与 Development Testing；`playwright-cli` 等开发者按需工具归入 Development Testing，CI/Gate 使用无人值守 Suites。
- 目标平台始终是 Windows、macOS、Linux；当前实现可 Windows-first，平台专属代码统一位于 adapter 内，并在规格中标注各平台实现状态。

## 文档尺寸

- 一份规格文档以 100–250 行为目标，阅读时间控制在 5–10 分钟。
- 少于约 60 行且总是一起阅读的内容合并为同一文档的章节。
- 超过约 400 行，或出现独立演进、独立负责人、独立协议时再拆分。
- 目录索引用于导航领域文档，不为单个小主题创建一层文件。

## README

- `README.md` 只提供当前目录的一句用途说明和文档链接。
- README 以 3–30 行为目标，并从普通规格文档的尺寸规则中豁免。
- 架构、产品行为、协议、算法、计划和测试正文使用有语义的文件名保存。
- README 保持目录导航属性，不承载大段规格内容。

## 目录形态

- 每个目录的领域条目采用单一形态：全是子目录，或全是内容文档。
- `README.md` 和 `AGENTS.md` 是目录元数据，不计入领域条目形态。
- 包含领域子目录的目录只提供导航元数据；正文进入对应子目录。
- 包含正文的叶子目录保持扁平，并通过同级文档组织章节。
- 新增主题前先判断它属于现有叶子目录，还是值得建立完整子域；禁止在同一层混放正文和领域子目录。

## 编号

- 有顺序的领域目录使用三位数前缀：`NNN_name/`。
- 叶子目录中的有顺序正文使用三位数前缀：`NNN-name.md`。
- 编号从 `000` 开始并补齐三位，例如 `000_overview/`、`001_product/`、`002_technical/`。
- `README.md` 和 `AGENTS.md` 作为元数据文件保留固定名称。
- 新增或调整顺序时，同一层级保持统一的三位数格式。

## 所有权表述

- 非必要不使用“不做什么”“不是什么”“不要X而要Y”等反向表述。规格直接描述需要的对象、职责、行为、流程、不变量和验收结果。
- 安全边界、兼容约束以及缺少排除项会产生实质歧义时，可以使用反向表述。
- 使用正向所有权句式：`X 管理 A。Y 管理 B。`
- 避免反向划界句式：`X 负责 A，但不负责 B。`
- 避免同类变体：`X 只负责 A，不处理 B。`、`X 管理 A，不创建或销毁 B。`
- 一个句子只声明当前主体拥有的职责；其他职责由对应主体单独声明。

## Rust分层

- `ccsm-core`保存领域类型、应用服务、ports和DTO，并保持Tauri-free。
- `ccsm-platform`实现SQLite、PTY、process、filesystem、Git、path和HookEndpoint adapters。
- `ccsm-desktop`作为Tauri composition root，依赖core/platform并实现commands、events、channels、windows和native WebViews。
- Tauri command handlers只执行DTO转换、service调用和error mapping。
- `ccsm-core`和`ccsm-platform`不得引用Tauri window、WebView或renderer类型。
- CI通过Cargo dependency graph和forbidden-import检查守住依赖方向。
- TypeScript UI通过`CcsmDesktopClient`访问Rust；其中`AppBackendClient/AppEvent`属于core边界，`BrowserSurfaceClient/BrowserSurfaceEvent`属于desktop host边界。raw Tauri invoke/event调用集中在desktop transport adapter。
- `revision`、`generation`和`seq`采用领域内语义，不作为所有DTO或events的通用字段。
- 用户mutation通过command response返回committed DTO或snapshot；`AppEvent`承载AppBackend异步变化，`BrowserSurfaceEvent`承载native browser变化；PTY bytes使用binary Channel。
- Provider的watch scope通过commands声明，Rust异步通知统一进入`DesktopEventStream`。
- Desktop crates不实现HTTP/WebSocket server或transport；未来`ccsm-web-server`作为独立composition root复用core DTOs和services。
- Claude/Codex/Copilot native Session ID仅接受认证HookReport；代码不得扫描provider data directory、transcript或mtime猜测身份。
