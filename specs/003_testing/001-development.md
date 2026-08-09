# Development Testing

Development Testing 为开发阶段提供按需、交互式、探索性的验证。它帮助复现问题、观察内部状态和快速确认修复方向。

这类运行由开发者主动发起，结果用于诊断。稳定且重复出现的场景会转化为自动化测试，并进入 [Automated Testing](000-automated.md) 的对应 Layer。

## 与自动化测试的边界

|          | Development Testing    | Automated Testing                   |
| -------- | ---------------------- | ----------------------------------- |
| 发起者   | 开发者按需启动         | Gate/CI 调度                        |
| 操作方式 | 交互、探索、可调整步骤 | 固定测试命令与断言                  |
| 环境     | 当前开发机器和目标设备 | GitHub Actions平台job或本地隔离环境 |
| 结果     | 诊断结论与复现材料     | 测试运行器状态与artifacts           |
| 门禁     | 独立人工记录           | Local/PR/Main/Nightly/Release Gate  |

开发测试可以使用真实用户交互和视觉判断。自动化测试使用确定性 assertions 和可重复 fixtures。

## 适用场景

- 新功能首次接入，自动化 contract 尚未稳定。
- UI geometry、focus、selection、IME、native child WebView 等视觉或交互问题。
- AppBackend/PTY/Hook/Git watcher 的竞态复现。
- GitHub Actions 失败后的本地诊断。
- 真实 Claude/Codex 长 Session 的探索性 smoke。
- 特定操作系统、显示器、输入法和用户配置组合。
- Release 前的人工视觉、真实输入法候选窗、硬件和系统集成 sign-off。

## 工具

```text
playwright-cli     按需连接 Windows WebView2 CDP
WebView DevTools   DOM、Canvas、network、performance
Rust debugger      AppBackend、process、Tauri adapter、state
structured logs    run/resource和领域竞态标记关联
SQLite tools       Space、Tab、Session 和 cache inspection
OS tools           process tree、PTY、window、filesystem watcher
```

`playwright-cli` 用于开发者交互式验证：snapshot、eval、keyboard、mouse、screenshot 和多 WebView观察。命名会话在工作结束时detach，进程清理使用本次运行记录的PID和sandbox路径。

重复执行的 Desktop Scenario 使用 `@wdio/tauri-service` 自动化，并进入 L4 Suite。

## 工作流

```text
create isolated dev sandbox
→ build/start debug executable
→ attach debugger or playwright-cli
→ reproduce and inspect
→ verify candidate change
→ capture useful artifacts
→ detach and clean owned resources
→ add/update automated regression
```

## 隔离

- 开发测试使用独立 data/cache/runtime directories 和 Space root。
- provider smoke 使用专用 fixture folder 和明确的 provider home。
- Browser profile、IPC endpoint、CDP port 和 artifacts 归属本次 dev run。
- 真实用户 Space、repository 和 provider transcript 保持原样。

## 输出

一次有价值的 Development Testing 应留下以下一种或多种结果：

- 可复现步骤和最小 fixture。
- event journal、日志、截图或 trace。
- 已确认的 ownership/state transition。
- 新增的 L1/L2/L3/L4 自动化回归。
- 明确记录的平台或环境限制。

## 自动化转化

满足以下任一条件时，将开发验证转成自动化回归：

- 问题曾导致 crash、data loss、错误 resume 或资源泄漏。
- 同一路径需要在多个平台重复验证。
- 修复依赖明确的 state transition、protocol event 或 geometry invariant。
- 手工步骤在两个以上开发周期重复出现。
- 该行为进入 PR 或 Release Gate 的验收范围。

优先选择最低可证明 Layer：纯逻辑进入 L1，跨语言边界进入 L2，真实进程进入 L3，完整桌面流程进入 L4。

Development Testing 本身不作为 PR 的无人值守 Gate。Release 所需证据由自动化 Suites 和明确的人工/硬件 sign-off 分别记录。
