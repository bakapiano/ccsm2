# CCSM v2 产品规格

CCSM v2 是本地桌面工作台，用一个可恢复的 **Space** 组织 CLI、浏览器、文件和Git视图。

Spaces 通过可嵌套的虚拟 Folder Tree 组织。Folder Tree 管理展示、排序和归档位置；每个 Space 引用一个磁盘 root folder，并保持自己的完整工作现场。多个 Spaces 可以共享同一个 root。

## 产品概念：Space

`Space` 的用户含义是“一整套工作现场”：

```text
Space
├─ root folder
├─ discovered Git tree
├─ Dockview layout
├─ Tabs
│  ├─ Shell/Claude/Codex/Copilot CLI Session
│  ├─ Browser
│  ├─ File Explorer
│  └─ Git
├─ active/focused state
└─ referenced resources
```

选择 `Space` 这个名称，是为了区分：

- `CliSession`：Shell、Claude、Codex 或 Copilot 的稳定 CCSM 记录；Agent CLI额外绑定 provider native Session。
- `GitRepository`：Space root或直属子目录中发现的repository。
- `Window`：操作系统窗口。
- `Tab`：Space 内的一个视图。

## 核心体验

- 用户创建、命名、切换和归档多个 Space。
- 每个 Space 绑定一个 root folder，File Explorer 和 CLI 默认 cwd 从该目录派生；多个 Spaces 可以共享同一个 canonical root。
- Git discovery自动发现Space root和直属子目录中的repositories。
- 每个 Space 独立保存 Tab 顺序、split、尺寸、active Tab 和各 Tab 状态。
- 应用重启后先重建布局，再由每种 Tab provider 独立恢复资源。
- CLI runtime 存活时直接 reattach；runtime 丢失时使用 Hook 上报的 native ID 执行 resume。
- 单个 Tab 恢复失败时显示可重试状态，其余布局继续可用。

## 参考来源

- [cmux SessionPersistence](https://github.com/manaflow-ai/cmux/blob/6089fa04d3effd27e43c5c6104a4eada62fe859f/Sources/SessionPersistence.swift)：`AppSessionSnapshot → windows → workspaces → layout + panels`；一个 workspace 保存完整 panel 布局和状态。
- [Herdr snapshot](https://github.com/herdrdev/herdr/blob/6f311498aeeb27c0973781961ef94e8d0016ed17/src/persist/snapshot.rs)：`SessionSnapshot → workspaces → tabs → layout + panes`；pane 快照保存 cwd、agent Session 和 launch argv。

CCSM 的 Space 采用相同原则：布局快照保存稳定资源引用，资源恢复按类型执行。
