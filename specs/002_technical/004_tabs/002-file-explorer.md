# File Explorer Tab

File Explorer Tab 为当前 Space 提供只读、可监听的虚拟文件树。

## State

```ts
interface FileExplorerTabState {
  spaceId: string;
  rootRelativePath: string;
  expandedPaths: string[];
  selectedPath?: string;
}
```

## Core API

```text
fs.list_directory(space_id, relative_path, cursor)
fs.stat(space_id, relative_path)
fs.set_watch_scope(tab_id, space_id, relative_paths[])
fs.clear_watch_scope(tab_id)
path.reveal(space_id, relative_path)
runtime.create(space_id, cwd_relative_path, provider)
```

`fs.list_directory` 支持分页和 cancellation。返回条目包含 name、relative path、kind、size、mtime、symlink metadata 和可选 Git decoration。

AppBackend将`space_id`解析为`root_id`。File Explorer使用active Space的ActiveRootContext watcher；每个Tab保留独立expanded/selected state。切回Space时重新读取已展开目录。

## Watch scope

- Provider mount时将root和expanded directories提交为当前Tab的watch scope。
- Expand/Collapse coalesce后替换整个scope；provider unmount或close时clear scope。
- ActiveRootContext合并全部File Explorer Tab scopes，并交给FileWatchAdapter。
- Windows/macOS adapter可以使用root-level recursive watch；Linux adapter可以从scope materialize所需inotify watches。
- Watch scope仅控制platform watcher范围；文件事件作为`AppEvent`通过统一`DesktopEventStream`发送。

## Path policy

- Space root 是 canonical capability root。
- 所有请求使用Space-relative path；platform filesystem adapter canonicalize后验证containment。
- 指向 root 外部的 symlink/junction 显示 link metadata，目录 traversal 返回 denied。
- Windows drive/UNC 与 macOS/Linux POSIX 语义由 `PlatformPaths` 和 `FileWatchAdapter` 处理。

## Updates

`FileWatchAdapter`将文件变化归并成`filesystem.changed { rootId, relativePaths, overflow }`。前端过滤active root并重新读取受影响的展开目录；overflow触发当前watch scope的完整refresh。

Copy Path由前端clipboard capability执行。Reveal使用平台opener。Open Terminal Here和Create CLI Tab Here将选中目录作为cwd提交给AppBackend。

File Explorer 保持只读树；单击普通文件通过 File Editor Provider 打开对应 Space-relative path。文件 create、rename、move 和 delete API 进入后续版本。

## Renderer

File Explorer renderer参考VS Code Explorer/tree/list的结构与交互，并适配CCSM现有DOM renderer：

- row固定22px，twistie宽16px，层级indent为16px。
- 文件夹、普通文件、code、config、JSON、Markdown、image、archive和symlink使用资源类型图标。
- hover、selection和keyboard focus使用独立状态；label超长时ellipsis。
- Arrow Up/Down/Home/End移动焦点，Arrow Left/Right折叠、展开或进入child，Enter打开文件或切换目录。
- 展开、选择和watch refresh继续使用`FileExplorerTabState`与现有filesystem DTO，不引入VS Code runtime依赖。

参考源码commit和MIT许可保存在`apps/desktop/vendor/vscode-explorer/`。
