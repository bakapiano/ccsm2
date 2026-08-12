# 持久化与 IPC

## Storage layout

Rust AppBackend是`data.db`的单一writer。数据库启用WAL、foreign keys、busy timeout和schema migration。

数据目录通过 `PlatformPaths` 获取：Windows 使用 LocalAppData 语义，macOS 使用 Application Support，Linux 使用 XDG data/state 目录。

```text
CCSM data directory
├─ data.db
├─ browser-profile/
└─ logs/
```

## data.db

`data.db`同时保存durable产品事实和rebuildable cache：

```text
# durable
schema_meta
settings
space_roots
spaces
space_folders
space_layouts
cli_sessions
tabs

# rebuildable
git_repositories_cache
git_status_cache
```

- `space_roots`保存`id/display_path/real_path/timestamps`；`real_path`建立唯一索引。
- `spaces`保存`id/name/icon/folder_id/folder_order/root_id/timestamps`；多个Spaces可引用同一个`root_id`。
- `space_roots.real_path` 创建后不可更新；API不提供 Change/Locate/Relocate Root command。
- `tabs`保存带`space_id/kind/state_version/state`的TabRecord。
- `space_layouts`保存`space_id/dockview_snapshot/active_tab_id/focused_group_id/layout_revision/updated_at`，并引用对应Space的Tab IDs。
- `settings`保存全局`last_active_space_id`和单窗口`window_state`，包括bounds、maximized和fullscreen。
- `tabs` 对 `kind='cli-session'` 建立 active `resource_id` partial unique index；对 `kind='git'` 建立 active `space_id` partial unique index。
- Browser Tab state保存`last_url/title/zoom`；global profile数据保存在filesystem store。
- `cli_sessions`保存启动配置、`desired_state`、`native_session_id`、`native_binding_state`和最后一次退出摘要。
- `cli_sessions`对`{provider, native_session_id}`建立non-null partial unique index，确保一个原生身份映射到一个未删除的CLI Session。
- Terminal runtime、runtime ID、PID、PTY handle、actual state和per-native-session resume mutex保存在AppBackend内存中。
- TabRecord mutation和引用它的space_layout row在同一transaction提交。
- Hook确认后直接更新`cli_sessions.native_session_id/native_binding_state`；ID冲突时拒绝更新并返回domain error。
- `settings`仅保存非敏感应用设置。CCSM首版不持久化credential或secret。
- `_cache`表通过foreign keys引用durable IDs，并在对应资源删除时cascade清理。
- `data.db`使用`synchronous=FULL`；cache更新使用debounce和批量transaction减少同步写入。

## Schema compatibility

`data.db`在v2内采用向后兼容的增量Schema：

- 新版本读取并升级所有已发布的旧Schema版本。
- 演进优先使用新增table、nullable/default column和index。
- 已发布的table/column语义保持稳定；结构替换通过新增结构、数据回填和兼容读取完成。
- `schema_meta`记录Schema版本和已完成migration IDs；migration保持幂等。
- durable tables执行兼容migration；`_cache` tables可在migration中清空或重建，并随后重新扫描Space roots。
- 早期开发数据库中的nullable `spaces.archived_at`作为兼容占位保留；打开数据库时将历史值归一化为`NULL`，产品模型和IPC不暴露Archive语义。

Space lifecycle写入规则：

- Switch提交旧Space layout，并更新`settings.last_active_space_id`。
- Delete完成scoped resource cleanup后，在一个transaction内删除Space-owned durable records和对应cache rows，并同步清理Space-owned filesystem artifacts。
- 可重建cache的清理失败写入日志；不可达数据在普通cache重建时移除，不创建durable cleanup queue。
- Space Delete移除当前`root_id`引用；删除active Space时先关闭其ActiveRootContext。最后一个引用消失后删除SpaceRoot record并cascade清理可重建cache。磁盘root folder和Agent CLI provider transcripts保留在原位置。

## Rebuildable cache

Cache tables保存可重新发现或计算的数据：

```text
git_repositories_cache
git_status_cache
```

- `git_repositories_cache`按`root_id`保存discovery results和`scanned_at`。
- `git_status_cache`按`repository_id`保存最近status snapshot和`captured_at`。
- `scanGeneration`仅存在于当前ActiveRootContext，用于过滤本进程内的迟到扫描结果。
- cache记录损坏、格式过期或引用失效时删除对应rows，并重新扫描相关Space roots。
- cache writes和关联的durable metadata可以在一个SQLite transaction内提交。

## Filesystem stores

- `browser-profile/` 是全局持久 WebView profile，保存共享 cookies、账号登录、storage 和 HTTP cache。
- `logs/` 保存AppBackend、desktop adapter、renderer和测试可观测日志。
- Agent CLI provider transcripts保持在provider data directory；CCSM不读取或扫描这些目录来推断native Session ID。
- Agent CLI登录由provider CLI管理；Git认证由Git工具链管理；Browser认证由platform WebView profile管理。
- Hook token属于单次runtime，保存在RuntimeManager和子进程环境中，并在runtime结束时丢弃。

## Global Browser Profile

- `ccsm-desktop`的`BrowserProfileManager`为所有Browser Tabs提供同一个platform website data store。
- Windows WebView2 使用共享 user data folder；macOS 使用持久 WKWebsiteDataStore；Linux 使用持久 WebKit data manager。
- Space Delete 和 Browser Tab Delete 保留全局 profile。
- Settings 提供 Clear Cache 和 Clear All Browser Data 两个显式操作。
- Future named profiles作为独立扩展，不与 Space identity绑定。

## Space Folder Tree

```text
space_folders {
  id, parent_id?, name, sort_order, collapsed,
  created_at, updated_at
}

spaces {
  folder_id?, folder_order, ...
}
```

Folder使用adjacency list。`parent_id = null`表示虚拟root；`spaces.folder_id = null`表示Unfiled。child folders和child Spaces分别按`sort_order`排序。`collapsed`默认`false`并随Folder record持久化。

树操作由单一 transaction 提交：

```text
folder.create(parent_id, name)
folder.rename(folder_id, name)
folder.move(folder_id, new_parent_id, order)
folder.reorder(parent_id, ordered_folder_ids)
folder.set_collapsed(folder_id, collapsed)
folder.delete(folder_id, strategy=promote_children)
space.move(space_id, folder_id, order)
space.reorder(folder_id, ordered_space_ids)
```

`folder.move` 使用 recursive CTE 验证 descendant 关系，并将最大深度限制为 32。`folder.delete` 将 direct child folders 和 Spaces 提升到原 parent，再删除目标 folder。移动、提升和 sibling order normalization 在同一 transaction完成。

Folder Tree mutation进入AppBackend单一队列，并在transaction commit后返回完整的committed tree snapshot。前端一次只提交一个结构mutation，并使用返回snapshot替换当前tree。Collapse/Expand立即更新UI，以debounce提交`folder.set_collapsed`，窗口关闭前执行final flush。

## Desktop adapter

```text
TypeScript CcsmDesktopClient
├─ AppBackendClient
├─ BrowserSurfaceClient
└─ DesktopEventStream
  ⇅ desktop transport adapter
Tauri invoke / event / Channel
  ⇅ core DTOs + desktop host DTOs
ccsm-desktop adapter
├─ service calls → ccsm-core AppBackend
└─ BrowserSurfaceManager → native child WebViews
```

- TypeScript UI和Tab Providers通过`CcsmDesktopClient`调用Rust services。
- raw Tauri invoke/event注册集中在desktop transport adapter。
- Tauri invoke承载command及其committed response。
- Tauri events承载generated `DesktopEvent`。
- Tauri binary Channel承载forward-only PTY bytes。
- desktop adapter执行DTO转换和domain error mapping。

```ts
interface CcsmDesktopClient {
  backend: AppBackendClient;
  browser: BrowserSurfaceClient;
  events: DesktopEventStream;
}

interface AppBackendClient {
  spaces: SpaceCommands;
  tabs: TabCommands;
  sessions: SessionCommands;
  files: FileCommands;
  git: GitCommands;
}

type AppEvent =
  | { kind: "space.healthChanged"; payload: SpaceHealthDto }
  | { kind: "session.runtimeChanged"; payload: SessionStateDto }
  | { kind: "session.bindingChanged"; payload: NativeBindingDto }
  | { kind: "git.statusChanged"; payload: GitStatusDto }
  | { kind: "filesystem.changed"; payload: FileChangeHintDto };

type BrowserSurfaceEvent =
  | { kind: "browser.navigationChanged"; payload: BrowserNavigationDto }
  | { kind: "browser.loadFailed"; payload: BrowserLoadErrorDto };

type DesktopEvent = AppEvent | BrowserSurfaceEvent;

interface FileChangeHintDto {
  rootId: string;
  relativePaths: string[];
  overflow: boolean;
}
```

Event payload使用完整领域snapshot或可重复处理的invalidation hint。`runtime_id`和`git_scan_generation`只出现在对应领域DTO中；`layout_revision`由layout command response返回。

File Explorer通过backend command声明watch scope。`filesystem.changed`经统一`DesktopEventStream`发送；watch scope不创建独立callback、channel或transport subscription。

Create、Rename、Move、Delete和layout save等用户mutation返回committed DTO、变更集合或领域snapshot，并由调用方更新store。Start Session返回`runtime_id + starting`；后续`live/exited/lost`作为`AppEvent`发送。Session reducer按同一runtime ID的状态机前进，迟到的`starting` response不能覆盖已经收到的后续状态。Command完成时不发送内容相同的镜像event。

## Future Web product boundary

未来`ccsm-web-server`复用ccsm-core DTOs和service ports，并增加：

```text
CONTROL_JSON   WebSocket text message
PTY_BINARY     WebSocket binary message
```

WebSocket authentication、pairing、client identity、backpressure和reconnect contract在独立Web产品中定义。当前desktop/core/platform crates不包含WebSocket transport trait、server、listener、端口配置或网络依赖。

## 一致性规则

- Space Tab/layout保存debounce；`layout_revision`阻止较早请求覆盖新布局，窗口关闭前执行final flush。
- AppBackend的后台任务产生`AppEvent`，BrowserSurfaceManager产生`BrowserSurfaceEvent`；desktop transport将两者合并为单一有序`DesktopEventStream`。
- renderer reload先建立event subscription并缓冲events，再读取Space snapshot，最后按到达顺序应用幂等events。
- Command调用方使用committed response直接upsert、delete或替换领域snapshot；一次mutation影响多个对象时response包含完整变更集合。
- Browser child WebView操作统一经过`BrowserSurfaceClient`和ccsm-desktop host。
