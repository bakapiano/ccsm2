# 内置 Tab

## 通用交互

- Tab header 显示类型图标；Claude Code 与 Codex 使用原版 CCSM 的彩色品牌图标。
- Tab header 提供独立关闭按钮。
- 每个Dockview group的Tab header最右侧提供纯加号New Tab操作；最后一个Tab关闭后保留空group header，使New Tab仍可用。
- 右键菜单依次提供 Close、Close Others、Close to the Right 和 Close All。
- Close Others、Close to the Right 与 Close All 作用于当前 Dockview group。
- 关闭动作从Space删除Tab并持久化新布局；应用内部的Space切换只卸载视图。

## CLI Session

- 首版提供 Shell、Claude Code 和 Codex 三个内置 Provider。
- Shell 使用平台默认 shell并拥有 runtime 生命周期；Claude/Codex额外拥有 Hook binding 和 native resume。
- runtime 存活时直接 reattach；runtime 丢失时显示恢复进度或 Resume 操作。
- Claude/Codex Hook尚未确认时显示binding pending；runtime结束仍未绑定时显示resume unavailable和Start New/Replace。
- 关闭 CLI Tab停止runtime并删除CliSession。Stop只停止当前runtime并保留Tab。
- 一个 CliSession只对应一个 CLI Tab；再次打开时激活所属 Space并聚焦已有 Tab。
- CLI Tab禁用 Duplicate。

用户自定义 CLI Provider进入后续版本。

## Browser

- 保存 URL、title 和导航偏好。
- 所有 Browser Tabs 使用同一个全局持久 Browser Profile，共享 cookies、账号登录、localStorage 和 cache。
- 切换 Tab 时保留页面状态；删除 Tab 时关闭浏览器资源。
- GUI重启后使用 global profile + last URL 创建新 WebView；navigation history、scroll、form runtime state重新开始。
- 外部页面使用空的应用 capability 集合。
- Duplicate创建新的 Browser Tab并复制当前 URL。

## File Explorer

- 以 Space root 为 capability root，并可定位到 Git tree 中选定的 repository 或 Space-relative 子目录。
- 保存展开节点、选择项和当前路径，并自动协调 watcher 变化。
- 首版支持 Copy Absolute/Relative Path、Reveal in Explorer/Finder、Open Terminal Here 和 Create CLI Tab Here。
- 文件树采用只读导航；单击普通文件时打开持久的 File Editor Tab。create、rename、delete 和 move 进入后续版本。
- Duplicate复制当前 Space-relative root、展开节点和选择状态。

## Git

- Git Tab 绑定当前 Space，并展示全部已发现 repositories。
- 每个 repository 使用独立 section 展示 changed files。
- 首版采用只读视图，详细行为见 [Git Tab](002-git-tab.md)。
- 每个 Space只有一个 Git Tab，Duplicate操作聚焦现有 Tab。
