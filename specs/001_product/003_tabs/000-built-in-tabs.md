# 内置 Tab

## 通用交互

- Tab header 显示类型图标；Claude Code、Codex 与 GitHub Copilot 使用彩色品牌图标。
- Tab header 提供独立关闭按钮。
- 每个Dockview group的Tab header最右侧提供纯加号New Tab操作；最后一个Tab关闭后保留空group header，使New Tab仍可用。
- 右键菜单依次提供 Close、Close Others、Close to the Right 和 Close All。
- Close Others、Close to the Right 与 Close All 作用于当前 Dockview group。
- 关闭动作从Space删除Tab并持久化新布局；应用内部的Space切换只卸载视图。

## CLI Session

- 首版提供 Shell、Claude Code、Codex 和 GitHub Copilot 四个内置 Provider。
- Shell 使用平台默认 shell并拥有 runtime 生命周期；Claude/Codex/Copilot额外拥有 Hook binding 和 native resume。
- runtime 存活时直接 reattach；runtime 丢失时显示恢复进度或 Resume 操作。
- Agent CLI Hook尚未确认时显示binding pending；runtime结束仍未绑定时显示resume unavailable和Start New/Replace。
- 关闭 Claude Code、Codex 或 GitHub Copilot Tab先用应用内Modal警告用户该操作会停止runtime并从`data.db`删除Tab与CliSession，确认后再从布局移除Tab并执行删除。普通Shell Tab直接关闭。Stop停止当前runtime并保留Tab。
- 一个 CliSession只对应一个 CLI Tab；再次打开时激活所属 Space并聚焦已有 Tab。
- CLI Tab禁用 Duplicate。
- CLI Tab保留带修饰键的输入语义：Codex中`Shift+Enter`输入换行而不提交，并兼容`Ctrl+Enter`；Claude Code中`Shift+Enter`输入换行而不提交；Windows上的Claude Code中`Alt+V`交给CLI读取系统剪贴板并粘贴图片。
- 所有CLI Tab的`Ctrl+C`在终端选区存在时复制选区，空选区时向PTY发送ETX；`Ctrl/Cmd+V`触发系统粘贴。`Cmd+C`复制当前终端选区。
- Claude Code与Codex Tab在用户开始键盘输入、粘贴或提交IME文本时立即滚动到当前输出底部，再将输入交给CLI。
- 单独按下Ctrl、Shift、Alt、Cmd等修饰键时保留当前终端滚动位置。
- 顶层窗口重新激活时，CLI Tab恢复窗口失活前的终端输入焦点；切回时点击的界面目标继续获得焦点。
- CLI Tab在Dockview连续resize和原生窗口最小化/恢复期间保留最后一个完整终端画面；最终PTY resize与对应TUI repaint完成后一次性切换到新画面。
- CLI Tab将Claude Code、Codex、GitHub Copilot及Shell输出中的Space内文件引用识别为链接；链接hover显示主题色实线与目标tooltip，`Ctrl+左键`打开或聚焦内置File Editor Tab并跳到指定行列。HTTP/HTTPS/FTP与OSC 8链接通过相同手势按Settings中的Links偏好进入同一Space内的内置Browser Tab或操作系统默认浏览器，初始偏好为内置Browser Tab；OSC 8链接静止时显示主题色点线。新建的链接目标Tab使用来源Dock右侧上沿对齐的最近Dock；来源位于右侧Dock时复用该组，单组布局从来源Dock向右切分。

用户自定义 CLI Provider进入后续版本。

## Browser

- 保存 URL、title 和导航偏好。
- Tab header跟随当前网站显示favicon；加载期间和图标缺失时显示Browser类型图标。
- Tab标题跟随网页`document.title`；页面标题为空时回退为当前域名或`Browser`。
- 所有 Browser Tabs 使用同一个全局持久 Browser Profile，共享 cookies、账号登录、localStorage 和 cache。
- 切换 Tab 时保留页面状态；删除 Tab 时关闭浏览器资源。
- GUI重启后使用 global profile + last URL 创建新 WebView；navigation history、scroll、form runtime state重新开始。
- 外部页面使用空的应用 capability 集合。
- Duplicate创建新的 Browser Tab并复制当前 URL。
- 工具栏右侧提供Open in default browser按钮，通过操作系统默认浏览器打开当前HTTP/HTTPS/FTP URL。

## Board

- Claude Code、Codex和GitHub Copilot CLI启动时获得当前Space作用域的`ccsm` MCP Server，以及`board_list`、`board_get`和`board_put`工具。
- `board_put`接收一个完整UTF-8 HTML文档。文档可内嵌CSS与JavaScript，也可引用浏览器可加载的版本固定外部包。
- 每个Board使用稳定`board_id`。首次写入创建Board Tab并放到来源CLI Tab右侧，再次写入更新并聚焦同一个Tab。
- Board Tab在sandboxed iframe中执行HTML交互，页面内部管理按钮、表单、动画和可视状态。
- Board标题来自HTML的`<title>`，工具栏提供手动Reload并显示当前加载状态。
- Board HTML保存在CCSM数据目录的Space作用域临时存储中；Tab与Dock布局保存在`data.db`，应用重启后恢复。
- 更新现有Board时，CLI先通过`board_get`读取当前revision，再以`expectedRevision`提交，revision冲突返回明确错误。
- 关闭Board Tab会从Space布局与Tab registry移除视图；HTML继续保留在当前Space的Board列表中，后续`board_put`会重新打开该Board。
- Board Tab禁用Duplicate。

## File Explorer

- 以 Space root 为 capability root，并可定位到 Git tree 中选定的 repository 或 Space-relative 子目录。
- 保存展开节点、选择项和当前路径，并自动协调 watcher 变化。
- 首版支持 Copy Absolute/Relative Path、Reveal in Explorer/Finder、Open Terminal Here 和 Create CLI Tab Here。
- 文件树采用只读导航；单击普通文件时在右侧Dock打开持久的 File Editor Tab。create、rename、delete 和 move 进入后续版本。
- Duplicate复制当前 Space-relative root、展开节点和选择状态。

## Git

- Git Tab 绑定当前 Space，并展示全部已发现 repositories。
- 每个 repository 使用独立 section 展示 changed files。
- 首版采用只读视图，详细行为见 [Git Tab](002-git-tab.md)。
- 每个 Space只有一个 Git Tab，Duplicate操作聚焦现有 Tab。
