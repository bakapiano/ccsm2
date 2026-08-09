# Space 恢复

## 启动顺序

```text
load last active Space
→ load TabRecords and referenced resources
→ create Dockview groups/panels
→ restore active/focused state
→ each TabProvider restores its resource
→ publish Space health
```

Tab 恢复状态：`restoring | live | degraded | failed`。Space health 汇总状态并保留完整布局。

## 恢复矩阵

| Tab           | 首选恢复                          | runtime 丢失后的恢复                                  |
| ------------- | --------------------------------- | ----------------------------------------------------- |
| CLI Session   | attach 相同 TerminalRuntime       | 按native Session ID获取进程内mutex，执行native resume |
| Browser       | reuse live child WebView          | 使用 global profile + last URL 创建新 WebView         |
| File Explorer | restore root/expanded/selection   | 重新扫描 Space root 并协调缺失路径                    |
| Git           | 相同root时reuse ActiveRootContext | 加载共享cache、激活root context并刷新status           |

CLI 的 in-flight turn 状态由 provider transcript 和新一轮 resume 结果协调。Browser 的 cookies/storage 来自全局持久 profile；URL、title 和可恢复的 view state 来自 TabRecord。

Terminal VT和scrollback属于当前应用生命周期。应用退出释放CLI runtime；下次启动创建新Terminal，并根据Session desired state执行new或native resume。

## CLI 恢复策略

- 当前应用内已存在的runtime自动attach。
- 当前 Space 中用户期望运行的 Session 自动 resume。
- 未打开 Space 在用户打开时恢复。
- 用户明确 Stop 的 Session 保持 stopped。
- Claude/Codex缺少native Session ID且binding为unavailable时不自动创建新会话，Tab进入degraded并提供Start New/Replace。
- 同时最多启动两个 cold resume；失败 Tab 进入 degraded并显示 Retry。

## 失败处理

- 单个 Tab 显示恢复错误、Retry、Replace 和 Close 操作。
- 重复native Session resume由AppBackend的keyed mutex合并。
- layout snapshot损坏时保留Tab records、使用默认布局，并把损坏记录隔离保存。
- Space root 缺失时进入 `root-missing`。Space 等待原路径恢复，并提供 Delete；其他路径通过 New Space创建。
