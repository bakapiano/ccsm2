# Rust AppBackend

CCSM桌面版在Tauri Rust主进程内创建一个`AppBackend`。TypeScript renderer通过Tauri commands、events和channels调用它。

## Crate boundaries

```text
ccsm-core
├─ domain types
├─ application services
├─ service ports/traits
└─ serializable DTOs/events

ccsm-platform ──depends on──> ccsm-core
├─ SQLite
├─ PTY/process tree
├─ filesystem/Git
├─ platform paths
├─ BoardStore + Board MCP
└─ RuntimeReportEndpoint

ccsm-desktop ──depends on──> ccsm-core + ccsm-platform + Tauri
├─ composition root
├─ Tauri command/event adapters
├─ window/native WebView lifecycle
└─ TypeScript bridge
```

`ccsm-core`的dependency graph不包含Tauri、WebView或桌面窗口类型。`ccsm-desktop`创建platform adapters，构造`AppBackend`，并将其放入Tauri managed state。

未来`ccsm-web-server`与`ccsm-desktop`平级，复用`ccsm-core + ccsm-platform`并增加WebSocket adapter。

## AppBackend state

```text
StateStore
BoardStore
SessionService
RuntimeManager
ActiveRootContext?
ShutdownToken
DomainEventBus
```

`RuntimeManager`在内存中持有所有Spaces的runtime registry、keyed resume mutex、PTY/process handles和read tasks。`ActiveRootContext`持有active Space root的filesystem watcher和Git tasks；切换相同canonical root时复用，切换不同root时替换。`StateStore`是`data.db`的单一writer。

Space Switch先保存旧布局，再切换ActiveRootContext并恢复新布局。RuntimeManager保持所有Spaces的CLI runtimes。

## Desktop adapter

TypeScript应用层依赖`CcsmDesktopClient`。其中`AppBackendClient/AppEvent`映射core services，`BrowserSurfaceClient/BrowserSurfaceEvent`映射ccsm-desktop native host。raw Tauri invoke/event调用集中在desktop transport adapter。

Tauri command handlers执行三个步骤：

```text
deserialize generated DTO
→ call AppBackend service method
→ map result/domain error to generated DTO
```

业务规则、SQLite query、process lifecycle和Git逻辑位于core/platform层。Mutation services返回committed DTO或snapshot。后台runtime、Hook和Git变化通过单一有序Rust channel发布，由desktop adapter映射为generated `AppEvent`；command完成时不发布镜像event。PTY output通过Tauri binary Channel传给ghostty-web。

## Runtime report endpoint

Claude/Codex/Copilot Hook与Board MCP运行在外部子进程中，通过当前用户作用域的RuntimeReportEndpoint上报：

```text
ccsm hook report
→ authenticated RuntimeReportEndpoint
→ AppBackend SessionService

ccsm mcp serve / board_put
→ write temp/boards/<space-id>/<board-id>.html
→ authenticated BoardChangeReport
→ AppBackend upsert Board Tab + board.changed
```

RuntimeReportEndpoint接收版本化`HookReport`与`BoardChangeReport`。Windows使用当前用户Named Pipe；macOS/Linux使用当前用户权限Unix socket。AppBackend验证token、provider、CLI Session、runtime ID、Space和Board revision。Hook token由RuntimeManager按runtime随机生成并仅保存在内存中。

PTY adapter向每个Agent CLI runtime注入当前Space、Board root和认证上下文。CLI shim将同一个`ccsm mcp serve`以invocation-scoped配置合并到Claude Code、Codex和GitHub Copilot的MCP集合。MCP Server通过`board_list/board_get/board_put`访问当前Space，并在`board_put`落盘完成后发送BoardChangeReport。

## Task isolation

PTY readers、Git discovery/status、filesystem watch和maintenance作为可取消Rust tasks运行。Task completion/panic转换为domain error并进入DomainEventBus。Blocking Git/filesystem/process操作进入专用blocking pool。

Tauri command adapter将bootstrap、Space create/switch/delete、layout/Tab持久化、目录与文件I/O、Git读取及runtime start/stop调度到blocking worker。原生事件线程完成DTO反序列化、任务调度和结果映射；blocking worker panic统一转换为`internal` command error。

## Lifecycle

Tauri setup构造AppBackend。主窗口退出、应用内updater安装、installer请求退出或OS shutdown signal触发统一`shutdown()`：冻结新命令、释放native surfaces、停止process trees、取消tasks、提交状态并关闭数据库。DesktopUpdateManager位于ccsm-desktop managed state，并在installer handoff时调用同一shutdown gate。

整个Rust进程异常退出时，Windows Job Object kill-on-close或Unix launch wrapper control-pipe EOF触发process-group cleanup。下一次启动从空RuntimeManager开始，并根据持久Session state协调恢复。
