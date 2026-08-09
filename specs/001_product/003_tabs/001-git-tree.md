# Git tree

每个Space绑定一个root folder，并展示该canonical root及直属子目录中的Git repositories。绑定同一root的Spaces共享repository和status cache。

## 展示

```text
Space root
├─ repository at root
├─ repository-a
└─ repository-b
```

- Git tree显示repository名称、相对路径、branch和dirty状态。
- Repository按Space-relative path排序。
- File Explorer 和 Git tree 使用同一个 Space root。
- active Space获得实时repository discovery、status和filesystem watcher结果。
- inactive Space显示最后一次cache，并在再次打开时协调最新状态。
- Git Tab 按 Git tree 顺序为每个 repository 展示一个 section。
- 新CLI Tab默认使用Space root；用户选择repository后使用其repository root作为cwd。

## 用户操作

- Refresh、Open CLI Here、Open File Explorer Here。
- Copy Path。
- Space root 缺失时显示 `root-missing`，原路径恢复后自动重新扫描。

启动时先显示已保存的 Git tree snapshot，后台 discovery 完成后协调最新结果。实现见[Git Tab 技术规格](../../002_technical/004_tabs/001-git.md)。
