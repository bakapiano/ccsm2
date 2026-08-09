# Space

Space 是一套独立、可命名、可恢复的工作现场。

```text
Space
├─ root folder
├─ Git tree
├─ Dockview layout
├─ Tabs
├─ active/focused state
└─ referenced resources
```

## 产品规则

- 创建 Space 时必须选择一个 root folder。
- SpaceRoot 创建后保持固定；其他路径通过 New Space建立新的工作现场。
- 多个 Spaces 可以绑定同一个 root folder，并保留各自独立的 layout、Tabs 和 CLI Sessions。
- Space 名称、图标、布局、Tab 状态和最后打开时间会持续保存。
- Space 通过 `folderId` 挂在虚拟 Space Folder Tree 中。
- File Explorer 以 Space root 为入口；CLI 默认以 Space root 为 cwd。
- Git tree自动发现Space root和直属子目录中的repositories。
- 每种 Tab Provider定义自己的 resource cardinality和Duplicate语义。
- 首版使用一个 Tauri 顶层窗口和一个 active Space；切换 Space 时保存并替换当前视图。
- Switch 保持 CLI runtimes 继续执行。
- Delete自动停止该Space的CLI runtimes并释放Tab resources；完成后删除CCSM状态并保留磁盘root folder、其他共享Spaces和provider transcripts。

Space的存储结构和一致性规则见[技术规格](../../002_technical/005_data/000-persistence-ipc.md)。
