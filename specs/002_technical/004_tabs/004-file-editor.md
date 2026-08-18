# File Editor Tab

File Editor Tab 管理一个 Space-relative UTF-8 文本文件的内存会话。Markdown在同一个编辑文档上提供Edit与Preview模式。产品行为见 [File Editor 用户行为规范](../../001_product/003_tabs/003-file-editor.md)。

## Tab identity 与 state

```ts
interface FileEditorTabState {
  relativePath: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop: number;
  wordWrap: boolean;
  markdownMode: "edit" | "preview";
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
fs.resolve_file_reference(space_id, displayed_path) -> ResolvedFileReferenceDto
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
- Terminal文件引用可使用Space-relative或absolute path；platform adapter canonicalize存在文件、验证root containment并返回规范化Space-relative path。路径解析失败时不创建TabRecord。
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

File Editor根据规范化文件扩展名选择内容引擎：`.md`与`.markdown`使用Markdown双模式引擎，其他文本文件使用CodeMirror 6。两类引擎都以CodeMirror `EditorState.doc`作为当前文本的唯一来源。每个File Editor Tab保留同一个Panel；Space切换产生的Dockview unmount解绑session listener，重新挂载时订阅文件事件并校验磁盘revision。

Markdown Preview使用固定版本`markdown-it@15.0.0`。渲染器启用`linkify`并关闭原始HTML；链接协议采用相对地址、`http`、`https`、`mailto`明确allowlist，生成的链接增加`target="_blank"`与`rel="noopener noreferrer"`。图片renderer输出可访问的替代文本，避免预览触发网络请求。渲染结果放入语义化`article`，样式完全使用应用CSS variables。

markdown-it默认规则覆盖：

- CommonMark块级和行内结构。
- 围栏代码块、表格与删除线。
- 自动链接。

Markdown Tab首次打开使用Preview模式，`markdownMode`与`previewScrollTop`随Tab state持久化。切换到Preview时读取当前`EditorState.doc`并生成预览DOM；渲染器按完整source字符串缓存已展示内容。Edit模式继续使用相同`EditorView`，因此selection、undo history、Dirty判断、保存和冲突处理与其他文本文件完全一致。Preview容器处理跨平台`Mod+S`保存快捷键。带行列位置的文件跳转会切换到Edit模式并定位CodeMirror selection。

普通文本由CodeMirror的`EditorView`承载输入、selection、IME、绘制与滚动；`EditorState`提供history和语言扩展状态。

CodeMirror配置包含：

- `basicSetup`的行号、当前行、history、查找替换、括号匹配、自动缩进和selection绘制。
- `language-data`按文件名动态加载语言包；超过1 MiB时保持plain text state。
- `Compartment`动态切换read-only和line wrapping。
- CCSM theme与highlight style使用应用CSS variables，跟随深浅模式。
- `Mod-S`保存、`Ctrl-H/Cmd-Option-F`替换、`Mod-G`跳转行和`indentWithTab`。

磁盘首次加载和clean external reload使用新的`EditorState`，从而重置旧undo history；普通Tab切换与Space切换保留当前state。Provider不维护自制textarea镜像、高亮器、搜索器或undo stack。

编辑session保存最近磁盘文本和一个`ChangeSet`组合器。每次`docChanged`将transaction changes合并到累计changes，并通过changes长度判断Dirty；输入路径读取`EditorState.doc.length`，保持零次全文materialization。保存或进入Markdown Preview时执行一次`doc.toString()`；保存成功后用当前文本重置磁盘baseline与累计changes；undo回到baseline时通过组合后的changes恢复Clean。

## Close 与退出

单Tab关闭在删除TabRecord前询问session。Cancel重新挂载原Panel；Save仅在成功后删除；Discard直接删除。

应用关闭和Space删除收集对应Dirty sessions，并展示Save All、Discard All和Cancel。Save All逐个调用`write_file`；任一失败时保持窗口和失败session。系统窗口close request由desktop transport拦截，确认完成后才允许native window退出。

## Tests

- platform tests覆盖BOM、CRLF、中文、revision冲突、binary和non-UTF-8分类。
- SQLite contract覆盖同Space path去重与恢复state。
- TypeScript unit tests覆盖标题消歧、语言识别、引擎选择、watch hint匹配、markdown-it安全配置、基础Markdown结构和Panel布局。
- Desktop Markdown scenario覆盖Preview初始状态、Edit键盘输入、Dirty状态、当前内容预览、Preview快捷键保存与磁盘结果，并保存截图证据。
- Development Testing使用`playwright-cli`连接Windows WebView2，覆盖打开去重、编辑Dirty、保存、关闭Cancel和磁盘结果。
- Terminal link scenario分别从Claude Code、Codex与GitHub Copilot的真实VT输出点击文件引用和HTTP URL，验证File Editor行列定位、Tab去重、内置Browser URL及Debug/Release构建。
