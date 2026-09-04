# Tab 平台

Tab 是可持久化的视图抽象。Session、PTY 和 WebView 分别使用独立资源身份。

## 数据模型

```ts
type TabKind =
  | "cli-session"
  | "browser"
  | "board"
  | "file-explorer"
  | "file-editor"
  | "git";

interface TabRecord<State = unknown> {
  id: string;
  spaceId: string;
  kind: TabKind;
  title: string;
  resourceId?: string;
  stateVersion: number;
  state: State;
  createdAt: number;
  updatedAt: number;
}
```

每个 Space 拥有自己的 Tab registry。Dockview layout 通过 `TabRecord.id` 引用视图；registry 是 kind、状态和生命周期的权威。

## Provider 契约

```ts
interface TabProvider<State> {
  readonly kind: TabKind;
  create(input: unknown): Promise<TabRecord<State>>;
  mount(tab: TabRecord<State>, host: HTMLElement): TabView;
  serialize(tab: TabRecord<State>): State;
  canClose(tab: TabRecord<State>): Promise<boolean>;
  close(tab: TabRecord<State>): Promise<void>;
  canDuplicate(tab: TabRecord<State>): boolean;
  duplicate?(tab: TabRecord<State>): Promise<TabRecord<State>>;
}

interface TabView {
  setActive(active: boolean): void;
  layout(bounds: DOMRectReadOnly): void;
  focus(): void;
  dispose(): void;
}
```

## 生命周期规则

- 创建 Tab 时先创建/选择底层 resource，再写入 TabRecord。
- Dockview mount/unmount 驱动 TabView 生命周期；resource 生命周期由对应 provider 管理。
- Tab inactive 时调用 `setActive(false)`；native browser 必须隐藏，终端停止 resize ownership。
- Tab header和右键菜单将用户关闭请求交给Desktop预检流程。预检通过`CliSession.provider`为全部非Shell Agent CLI展示警告，并为dirty File Editor展示保存确认。预检通过后调用Dockview Panel close；`onDidRemovePanel`提交不含目标Panel的布局并调用`deleteTab`。CLI删除停止runtime并删除CliSession；Browser删除关闭native surface。布局恢复和Space切换期间的Panel移除跳过该流程。
- Dockview使用right header action渲染每个group的New Tab加号。`noPanelsOverlay=emptyGroup`保留最后一个空group，使零Tab状态仍有创建入口。
- Provider定义resource cardinality和Duplicate语义。
- Space layout snapshot 与 TabRecord 分开持久化，恢复时先加载 records，再重建 Dockview。
- 新 Space创建Shell、Files、Changes三个默认Tab；Dockview把Shell放入左组，把Files与Changes放入同一个右组并激活Shell。
- File Editor与Browser的新Panel以来源组为锚点解析右侧目标：最近的右侧上沿对齐组优先，来源组已有左邻组时复用来源组，单组布局使用`direction='right'`创建新组。
- Dockview持久snapshot在恢复前将全部Panel renderer归一化为`onlyWhenVisible`。Panel先创建轻量`DeferredContentRenderer`，其`onShow`将真实Provider renderer加入frame scheduler；scheduler每个animation frame最多实例化两个renderer，WebView暂停animation frame时使用100ms watchdog slice且每个slice仍最多执行两个。隐藏或销毁的待执行任务即时取消，active/focused Panel优先进入队列。
- Tab header随Dockview结构同步恢复，使大量历史Tab立即可导航；Provider DOM、CodeMirror、ghostty-web和Git renderer在Panel首次可见时创建。

## 内置资源绑定

| Tab kind        | resourceId           | native owner             |
| --------------- | -------------------- | ------------------------ |
| `cli-session`   | `cli_session_id`     | Rust AppBackend          |
| `browser`       | `browser_surface_id` | Tauri host               |
| `board`         | `board_id`           | Space BoardStore         |
| `file-explorer` | `space_id`           | Space filesystem service |
| `file-editor`   | Space-relative path  | Space filesystem service |
| `git`           | `space_id`           | GitStatusService         |

- CLI view mount 时 attach runtime；打开已有 CliSession时通过 Tab index聚焦唯一 CLI Tab。
- Browser panel提供DOM anchor和toolbar；`BrowserSurfaceClient`同步bounds、visibility、focus和navigation。
- `BrowserProfileManager` 创建一个全局持久 profile handle，并提供给所有 Browser surfaces。
- Board panel通过`AppBackendClient.readBoard`读取完整HTML，并以`sandbox="allow-scripts allow-forms"`的iframe `srcdoc`呈现；`board.changed`触发同一`board_id`的局部reload。
- Board iframe使用opaque origin与`no-referrer`策略。JavaScript、表单和外部browser packages在该frame中运行，页面交互状态由HTML管理。
- File Explorer state 保存 Space-relative root、展开节点和选择项；只读 filesystem API 使用 canonical capability root。
- File Editor state 保存 Space-relative path、selection、scroll 和 wrap；未保存文本与 undo history 保存在 renderer 内存会话。
- Git Tab state 保存 section collapse 和 selection；同一 Space 的 Open Git 操作复用已有 Tab。
- Browser Duplicate创建新 surface并复制 URL；File Explorer Duplicate复制当前相对 root和view state。
- Dockview使用pointer DnD backend；drag开始时全部native child WebView临时隐藏，pointerup、cancel或drop后按各Panel visibility恢复。

## Space Navigation Tree

前端根据 flat `SpaceFolderRecord[] + SpaceRecord[]` 构建虚拟树。每个 parent 分别排序 child folders 和 Spaces，并渲染 folders-first 结构。

Drag/drop生成typed move/reorder command。AppBackend串行执行tree mutations并返回committed tree snapshot，前端使用snapshot替换当前tree；搜索结果携带folder breadcrumb，并在选中时展开ancestor chain。
