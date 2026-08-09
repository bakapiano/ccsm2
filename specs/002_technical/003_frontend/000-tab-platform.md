# Tab 平台

Tab 是可持久化的视图抽象。Session、PTY 和 WebView 分别使用独立资源身份。

## 数据模型

```ts
type TabKind = "cli-session" | "browser" | "file-explorer" | "git";

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
- Dockview用户关闭事件先提交不含目标Panel的布局，再调用`deleteTab`。CLI删除停止runtime并删除CliSession；Browser删除关闭native surface。布局恢复和Space切换期间的Panel移除跳过该流程。
- Provider定义resource cardinality和Duplicate语义。
- Space layout snapshot 与 TabRecord 分开持久化，恢复时先加载 records，再重建 Dockview。

## 内置资源绑定

| Tab kind        | resourceId           | native owner             |
| --------------- | -------------------- | ------------------------ |
| `cli-session`   | `cli_session_id`     | Rust AppBackend          |
| `browser`       | `browser_surface_id` | Tauri host               |
| `file-explorer` | `space_id`           | Space filesystem service |
| `git`           | `space_id`           | GitStatusService         |

- CLI view mount 时 attach runtime；打开已有 CliSession时通过 Tab index聚焦唯一 CLI Tab。
- Browser panel提供DOM anchor和toolbar；`BrowserSurfaceClient`同步bounds、visibility、focus和navigation。
- `BrowserProfileManager` 创建一个全局持久 profile handle，并提供给所有 Browser surfaces。
- File Explorer state 保存 Space-relative root、展开节点和选择项；只读 filesystem API 使用 canonical capability root。
- Git Tab state 保存 section collapse 和 selection；同一 Space 的 Open Git 操作复用已有 Tab。
- Browser Duplicate创建新 surface并复制 URL；File Explorer Duplicate复制当前相对 root和view state。
- Dockview使用pointer DnD backend；drag开始时全部native child WebView临时隐藏，pointerup、cancel或drop后按各Panel visibility恢复。

## Space Navigation Tree

前端根据 flat `SpaceFolderRecord[] + SpaceRecord[]` 构建虚拟树。每个 parent 分别排序 child folders 和 Spaces，并渲染 folders-first 结构。

Drag/drop生成typed move/reorder command。AppBackend串行执行tree mutations并返回committed tree snapshot，前端使用snapshot替换当前tree；搜索结果携带folder breadcrumb，并在选中时展开ancestor chain。
