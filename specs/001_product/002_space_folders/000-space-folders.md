# Space Folder Tree

Space Folder 是管理 Spaces 的虚拟树节点。它与磁盘目录、Space root folder 和 Git tree 各自拥有独立身份。

## 结构

```text
Spaces
├─ Work
│  ├─ Client A
│  │  ├─ Space: Backend
│  │  └─ Space: Research
│  └─ Internal
│     └─ Space: CCSM
├─ Personal
│  └─ Space: Notes
└─ Unfiled
   └─ Space: Scratch
```

- Folder 可以包含 child folders 和 Spaces。
- Space 作为叶节点归属一个 folder；`folderId = null` 表示位于虚拟 root 的 Unfiled 区域。
- Folder 嵌套只改变侧边栏组织关系。
- Space 的 root folder、CLI cwd、Git repositories、Tabs 和 layout保持原有状态。
- Sibling folders 和 sibling Spaces 分别保留用户排序；UI 在同一层先展示 folders，再展示 Spaces。

## 操作

- Create Folder：在当前 folder 或虚拟 root 下创建。
- Rename：更新 folder label。
- Move Folder：拖入另一个 folder 或虚拟 root。
- Move Space：拖入任意 folder 或 Unfiled。
- Reorder：调整同一 parent 下 folders 或 Spaces 的顺序。
- Collapse/Expand：折叠状态随Folder保存，并在应用重启后恢复。
- Delete Folder：确认后将 child folders 和 Spaces 提升到 parent，再删除空 folder。

拖动 folder 到自身或 descendant 的操作返回原位置。移动和排序完成后整棵树保持稳定，不改变任何 Space resource lifecycle。

## 侧边栏

- 侧边栏按树状结构展示 folders 和 Space leaves。
- 子树使用8px紧凑层级缩进和12px leaf spacer；Space名称和行空白区域使用Pointer Events拖放，超过4px阈值后显示跟随鼠标的名称ghost，命中Folder或Unfiled后强调目标并提交同一个Space move；普通点击保持Space切换语义。Folder拖动ghost保留Folder图标。
- Folder与Unfiled保留资源图标；Space叶节点只显示名称，不显示前置workspace图标。
- 每个 Space leaf 显示名称、状态和必要的 activity indicator。
- active Space 在父级折叠时仍保持运行；展开祖先链后可重新定位。
- 搜索结果保留 folder breadcrumb，选择结果时展开对应祖先链。

## 身份与命名

- Folder 使用稳定 UUID，rename 和 move 保持 ID。
- Space与Folder名称trim后必须非空，最长64个Unicode字符；前端输入与持久层执行同一限制。
- Tree path 用于展示；持久化引用使用 folder ID。
- 同名 folder 通过 breadcrumb 区分。
- Folder 和 Space 的删除使用独立确认流程。

树的存储、cycle validation 和事务语义见[持久化规格](../../002_technical/005_data/000-persistence-ipc.md)。
