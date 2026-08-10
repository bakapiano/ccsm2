# 内置 Tab Provider Registry

`TabProvider`是新增Tab类型的源码级扩展点。所有首版Provider随应用编译，并在TypeScript composition root启动时注册。

## Provider contract

```ts
interface TabProvider<Kind extends TabKind, State, CreateInput> {
  readonly kind: Kind;
  readonly stateVersion: number;

  create(input: CreateInput): Promise<TabRecord<State>>;
  decodeState(raw: unknown, storedVersion: number): State;
  mount(tab: TabRecord<State>, host: HTMLElement): TabView;
  serialize(tab: TabRecord<State>): State;

  canClose(tab: TabRecord<State>): Promise<boolean>;
  close(tab: TabRecord<State>): Promise<void>;
  canDuplicate(tab: TabRecord<State>): boolean;
  duplicate?(tab: TabRecord<State>): Promise<TabRecord<State>>;
}
```

`stateVersion`描述该Provider的Tab state格式。Provider读取自身已发布的旧state版本，并由应用测试覆盖向后兼容。

## Registry

```ts
class TabProviderRegistry {
  register(provider: TabProvider<any, any, any>): void;
  get(kind: TabKind): TabProvider<any, any, any>;
}

function createBuiltInProviders(deps: AppDependencies) {
  return [
    createCliSessionProvider(deps.cli),
    createBrowserProvider(deps.browser),
    createFileExplorerProvider(deps.files),
    createFileEditorProvider(deps.files),
    createGitProvider(deps.git),
  ];
}
```

- composition root构造Provider并注入其使用的typed services。
- Registry按稳定`kind`索引Provider；重复kind在启动时产生配置错误。
- Tab创建、恢复、mount、close和duplicate通过同一个Registry分派。
- Dockview adapter根据TabRecord查找Provider并创建Panel view。
- Rust资源继续通过生成DTO和desktop adapter访问。

## 当前Providers

| kind            | state                              | resource owner           |
| --------------- | ---------------------------------- | ------------------------ |
| `cli-session`   | terminal view preferences          | AppBackend CliSession    |
| `browser`       | URL、title、zoom                   | Tauri BrowserSurface     |
| `file-explorer` | relative root、expanded、selection | Space filesystem service |
| `file-editor`   | path、selection、scroll、wrap      | Space filesystem service |
| `git`           | section collapse、selection        | GitStatusService         |

Provider state随TabRecord持久化。PTY、WebView、watcher和CLI process使用独立resource identity与生命周期。

## 新增Tab类型

新增源码内Tab类型执行以下步骤：

1. 为`TabKind`增加稳定kind，并定义typed state与create input。
2. 实现`TabProvider`和对应view。
3. 在composition root注册Provider并注入所需services。
4. 为Tab state decode、生命周期、恢复和resource cleanup增加测试。
5. 在产品规格中声明用户行为和Duplicate规则。

新增类型需要Rust能力时，在`ccsm-core`定义DTO/service contract，在`ccsm-platform`实现平台adapter，并通过`ccsm-desktop`暴露给可信主renderer。

## 失败处理

- state decode失败将该Tab置为failed，并保留原始state供诊断。
- mount或resource restore失败显示局部error panel和Retry/Close操作。
- 单个Provider失败保留Space其余布局和Tabs。
- duplicate registration在开发和CI启动检查中失败。

## Future third-party plugins

运行时安装、动态bundle loading、API version、permission approval、sandbox、升级和卸载归入未来第三方插件产品规格。届时第三方adapter可以复用Tab生命周期概念，并拥有独立的安全与兼容contract。
