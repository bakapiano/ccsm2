# Git Tab

Git Tab 是当前 Space 的只读 Source Control 总览。

## 布局

Git tree 发现多少个 repository，Git Tab 就展示多少个可折叠 section：

```text
Git
├─ repository-a · main · 3 changes
│  ├─ M  src/app.ts
│  ├─ A  src/new.ts
│  └─ D  old.txt
├─ repository-b · feature/x · clean
└─ repository-c · dev · 1 change
   └─ ?  notes.md
```

- section 顺序跟随 Git tree。
- header 显示 repository 名称、必要时显示 Space-relative path、branch 和 change count。
- clean repository 仍保留 section，并显示 `No changes`。
- section 的 collapsed state 随 Git Tab 保存。

## 文件状态

首版显示 modified、added、deleted、renamed、copied、type-changed、untracked 和 conflicted 等 Git status。rename/copy 同时显示原路径。

文件行采用只读展示。首版范围包含自动刷新和 loading/error/clean 状态；stage、unstage、commit、discard、diff、checkout 和文件操作进入后续版本。

每个 Space 默认拥有一个 Git Tab；再次执行 Open Git 时聚焦已有 Tab。
