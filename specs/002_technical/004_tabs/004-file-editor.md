# File Editor Tab

File Editor Tab 管理一个 Space-relative UTF-8 文本文件的内存编辑会话。产品行为见 [File Editor 用户行为规范](../../001_product/003_tabs/003-file-editor.md)。

## Tab identity 与 state

```ts
interface FileEditorTabState {
  relativePath: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop: number;
  wordWrap: boolean;
}
```

- Tab kind 为 `file-editor`。
- `resource_id` 保存规范化的 Space-relative path。
- SQLite partial unique index约束`(space_id, resource_id)`，同一文件只对应一个Tab。
- Tab state仅保存路径和视图状态；未保存文本与undo history保存在renderer内存。
- 正常启动根据Tab state重新读取磁盘，不持久化Dirty文本。

同名文件标题由前端在当前Space的File Editor Tabs中计算。标题使用文件名；冲突时附加能区分全部同名项的最短父目录后缀。Tooltip固定显示Space-relative path。

## Core API

```text
tabs.create_file_editor(space_id, relative_path) -> TabDto
fs.read_file(space_id, relative_path) -> FileDocumentDto
fs.write_file(
  space_id,
  relative_path,
  content,
  expected_revision,
  utf8_bom,
  line_ending,
  overwrite,
  recreate
) -> WriteFileResultDto
```

`FileDocumentDto`包含规范化为LF的编辑文本、revision、UTF-8 BOM、原始换行格式、大小、可编辑状态和语法高亮开关。读取发生在blocking worker，不阻塞Tauri主线程。

## Capability 与格式

- AppBackend通过`space_id`解析`RootDescriptor`。
- platform adapter拒绝absolute、parent traversal和canonical root外的symlink target。
- platform adapter先读取metadata；超过5 MiB时不读取内容。
- 读取检测NUL binary和UTF-8 decode失败，并返回typed unsupported状态。
- 不超过1 MiB的支持文件启用语法高亮；1–5 MiB使用纯文本层。
- renderer中的文本统一使用LF；写入时按加载记录恢复LF或CRLF。
- UTF-8 BOM由独立字段保存并在写入时恢复。
- 编辑文本是否包含末尾LF决定保存结果的末尾换行状态。

## Revision 与保存

platform adapter根据文件bytes、size和mtime生成进程内revision token。普通保存必须提交加载时的`expected_revision`：

1. 当前磁盘revision匹配时写入。
2. revision不匹配时返回`conflict`，磁盘内容不变。
3. `overwrite=true`用于用户确认后的覆盖。
4. 文件缺失时返回`conflict`；`recreate=true`仅用于用户确认后的重建。
5. 保存成功返回新revision，renderer以当前文本建立新的Clean基线。

写入保持原BOM和换行格式。保存失败保留当前内存文本、undo history和Dirty状态。

## Renderer session

File Editor Provider为每个Tab保留独立内存session。Dockview view mount/unmount只绑定和解绑DOM及filesystem event listener；关闭确认期间session继续存在。

session状态为：

```text
Loading -> Clean -> Dirty -> Saving -> Clean
                    |          |
                    v          v
                 Conflict    Dirty + error

Clean + external change -> reload + Clean
Dirty + external change -> Conflict
Clean + deleted          -> Read-only
Dirty + deleted          -> Conflict
```

filesystem watcher只发送invalidation hint。Clean session重新调用`read_file`并重建undo history；Dirty session读取metadata/revision用于分类，但保留本地文本。

## 编辑层

V1 renderer使用原生`textarea`承载输入、selection和IME composition。镜像`pre`层渲染escaped syntax tokens与括号匹配；行号和当前行层随textarea scroll同步。

Provider实现：

- 自动缩进与Tab空格插入
- session undo/redo history
- 文件内查找、替换与Replace All
- 跳转行
- selection行列状态
- 每Tab word wrap state
- Ctrl/Cmd快捷键分派

镜像层永远escape文件内容，不将文件文本解释为HTML。

## Close 与退出

单Tab关闭在删除TabRecord前询问session。Cancel重新挂载原Panel；Save仅在成功后删除；Discard直接删除。

应用关闭和Space删除收集对应Dirty sessions，并展示Save All、Discard All和Cancel。Save All逐个调用`write_file`；任一失败时保持窗口和失败session。系统窗口close request由desktop transport拦截，确认完成后才允许native window退出。

## Tests

- platform tests覆盖BOM、CRLF、中文、revision冲突、binary和non-UTF-8分类。
- SQLite contract覆盖同Space path去重与恢复state。
- TypeScript unit tests覆盖标题消歧、语言识别、watch hint匹配、括号与光标位置。
- Development Testing使用`playwright-cli`连接Windows WebView2，覆盖打开去重、编辑Dirty、保存、关闭Cancel和磁盘结果。
