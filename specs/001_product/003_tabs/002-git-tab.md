# Changes Tab

Changes Tab 是当前 Space 的只读 Source Control 与变更审阅视图。Open Git
继续聚焦同一 Space 的 Changes Tab。

## 布局

Tab 顶部显示 `Changes`、刷新状态和变更总数。主体采用双栏布局：

- 左侧是可滚动的逐文件 unified diff，宽度占主体的剩余空间。
- 右侧是 220px 文件导航，包含路径过滤框与 repository sections。
- 点击右侧文件会滚动并聚焦左侧对应 diff；当前文件随左侧滚动同步高亮。
- 520px 以下的窄面板隐藏文件导航，让 diff 保持可读宽度。

Git tree 发现多少个 repository，Changes Tab 就展示多少个可折叠 section：

```text
Git
├─ repository-a · main · 3 changes
│  ├─ [code] src/app.ts  M
│  ├─ [code] src/new.ts  A
│  └─ [text] old.txt     D
├─ repository-b · feature/x · clean
└─ repository-c · dev · 1 change
   └─ [markdown] notes.md  U
```

- section 顺序跟随 Git tree。
- header 显示 repository 名称、必要时显示 Space-relative path、branch 和 change count。
- clean repository 仍保留 section，并显示 `No changes`。
- section 的 collapsed state 随 Changes Tab 保存。
- 文件行首使用与 Files Tab 相同的资源类型图标，行尾用无边框语义色短代码显示 Git status。

左侧按 repository 和 status snapshot 的文件顺序投影 diff。每个文件拥有 sticky
header，显示展开状态、路径、增加行数与删除行数。文件 header 可以折叠内容，折叠状态随
Changes Tab 保存。
文件 header 的资源类型图标与 Files Tab 共享同一套扩展名解析和 SVG 资源。

## Diff

- tracked 文件展示 working tree 相对 `HEAD` 的合并结果，覆盖 index 与 worktree 的最终内容。
- 初始 repository 使用 empty tree 作为比较基线。
- untracked 文件投影为全文件新增。
- rename/copy header 同时显示原路径和目标路径。
- text diff 展示 hunk header、旧/新行号、增删标记、上下文行和行尾提示。
- added、deleted、hunk 与 context 使用不同的行背景；代码 token 根据目标文件名加载语言高亮。
- binary 与超出展示上限的内容在文件 section 内显示明确摘要。
- diff 读取期间保留文件 header 和加载状态；单文件读取错误归属该文件。

## 文件状态

首版显示 modified、added、deleted、renamed、copied、type-changed、untracked 和 conflicted 等 Git status。rename/copy 同时显示原路径。

文件状态和 diff 采用只读展示，并包含自动刷新、loading、error 和 clean 状态。

每个 Space 默认拥有一个 Changes Tab；再次执行 Open Git 时聚焦已有 Tab。
