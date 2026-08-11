# 桌面交互

## Space 操作

- New Space：先选择 root folder，再创建空布局或从模板创建。
- Switch Space：保存当前布局、detach当前视图并挂载目标Space；后台CLI runtimes继续执行，inactive root的文件/Git实时更新暂停。
- Rename：更新 Space metadata。
- Delete：确认后停止该Space的CLI、关闭Tab resources并清理cache。全局Browser Profile保持原样。
- Move to Folder：更新虚拟 tree 位置并保持运行状态和 root folder。

## Tab 操作

- New Tab 菜单展示 Shell、Claude Code、Codex、Browser、File Explorer、Git 和其他内置 Providers。
- 新CLI Tab默认在Space root启动；用户可从Git tree选择某个repository root。
- Tab 支持 drag、split、move group、pin 和 rename；Duplicate由具体 Tab Provider声明。
- 用户关闭Tab会把它从Space中删除。关闭CLI Tab前显示应用内警告并要求确认，确认后停止runtime并从`data.db`删除Tab与CliSession；Browser Tab同时关闭native WebView。Space切换产生的内部视图卸载保持资源。
- active Tab 获得 focus 和 input/resize ownership。

## Agents

- 左侧栏底部列出全部Space中的Claude Code和Codex Tabs。
- 每项显示provider图标、Tab名称、Space名称及`starting/idle/working/blocked/stopped`状态。
- 点击Agent先切换所属Space，再激活所属Tab并把终端输入焦点带到前台。
- 当前Space中每个可见Dockview group的Agent使用选中背景；切换、分屏和关闭Tab时即时同步。
- `blocked`和`working`项目优先排列，其后为`starting/idle/stopped`。
- Spaces与Agents之间的水平separator支持pointer拖动、键盘调整和双击恢复默认高度；Agents高度本地持久化，同时为Space tree保留最小可用高度。

## 启动体验

- 首版创建一个 Tauri 顶层窗口；第二次启动聚焦已有窗口。
- 默认打开上次 active Space。
- 恢复期间立即显示布局骨架和每个 Tab 的独立状态。
- `Space is ready` 表示所有必须资源完成恢复；degraded Tab 保持可见和可操作。
- Git tree 先显示已保存 snapshot，再以后台扫描结果增量协调。
- 切回Space时重新协调其root在inactive期间发生的文件和Git变化。

## 退出体验

- Close Main Window和Quit触发完整资源释放并退出应用。
- spawned Shell/Claude/Codex进程树、PTY、native WebViews和watchers在退出流程中关闭。
- 下次启动根据Session desired state恢复当前Space。
