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
└─ HookEndpoint

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

## HookEndpoint

Claude/Codex Hook运行在外部子进程中，通过受限HookEndpoint上报：

```text
ccsm hook report
→ authenticated HookEndpoint
→ AppBackend SessionService
```

HookEndpoint只接受版本化`HookReport`。Windows使用当前用户Named Pipe；macOS/Linux使用当前用户权限Unix socket。endpoint验证token、provider、session和runtime ID。Hook token由RuntimeManager按runtime随机生成并仅保存在内存中。

## Task isolation

PTY readers、Git discovery/status、filesystem watch和maintenance作为可取消Rust tasks运行。Task completion/panic转换为domain error并进入DomainEventBus。Blocking Git/filesystem/process操作进入专用blocking pool。

## Lifecycle

Tauri setup构造AppBackend。主窗口退出、installer请求退出或OS shutdown signal触发统一`shutdown()`：冻结新命令、释放native surfaces、停止process trees、取消tasks、提交状态并关闭数据库。首版不包含应用内updater service。

整个Rust进程异常退出时，Windows Job Object kill-on-close或Unix launch wrapper control-pipe EOF触发process-group cleanup。下一次启动从空RuntimeManager开始，并根据持久Session state协调恢复。
