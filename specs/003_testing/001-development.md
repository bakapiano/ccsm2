# 本地 Desktop E2E 调试

本文定义开发者在本机调试 CCSM 桌面场景的统一方式。本地与 GitHub Actions 使用相同的 WebdriverIO scenarios、`@wdio/tauri-service`、embedded provider 和 E2E executable。

## 两个本地循环

日常编写 TypeScript、CSS 和 Rust 时使用：

```powershell
pnpm dev
```

该命令提供 Tauri dev 与 Vite HMR。需要自动操作 executable、复现 CI 场景或调试测试时使用 Desktop E2E 入口：

```powershell
pnpm test:desktop:build
pnpm test:desktop
```

前者构建启用测试插件的 E2E executable，后者通过 `@wdio/tauri-service` 启动应用并执行场景。

## 本地架构

```text
Desktop Scenario
→ WebdriverIO local runner
→ @wdio/tauri-service
→ E2E executable
→ embedded WebDriver
→ main WebView interaction
→ assertion + screenshot + GIF + logs
```

共享 WDIO 配置使用：

```ts
services: [
  [
    "tauri",
    {
      appBinaryPath: process.env.CCSM_E2E_APP_BINARY,
      driverProvider: "embedded",
    },
  ],
];
```

Windows 与 Linux 使用同一配置文件。平台启动代码解析当前 E2E executable，Linux 同时准备当前 GUI session 或 Xvfb display。

## E2E 构建

Desktop crate 提供专用 Cargo feature：

```toml
[features]
e2e = [
  "dep:tauri-plugin-wdio-webdriver",
  "dep:tauri-plugin-wdio",
]
```

Tauri composition root 在 `e2e` feature 下注册两个插件和对应 capability。普通 dev/release 构建使用默认 feature；Desktop E2E 命令使用 `e2e` feature 和测试专用 Tauri 配置。

测试 executable 内嵌 frontend assets 并独立启动。每次构建输出明确的 executable 路径，并设置 `CCSM_E2E_APP_BINARY` 供 WDIO 使用。

## 命令契约

仓库需要提供以下稳定命令：

```text
pnpm test:desktop:build                 build current-platform E2E executable
pnpm test:desktop                       run all current-platform Desktop Scenarios
pnpm test:desktop -- --spec <file>      run one spec file
pnpm test:desktop:debug -- --spec <file> run one spec with debug logging and breakpoints
pnpm test:desktop:evidence -- --spec <file> run one spec and retain GIF evidence
```

CI 的 `pnpm test:desktop:ci` 调用同一 runner，并增加 CI reporter、固定 timeout 和 artifact 输出路径。

## 调试单个场景

推荐调试流程：

```text
build E2E executable once
→ select one spec
→ run through @wdio/tauri-service
→ stop at test breakpoint or browser.debug()
→ inspect DOM, Tauri command result and logs
→ continue or rerun the same spec
→ retain the final regression and evidence
```

测试代码可以使用 WebdriverIO locator、`browser.debug()`、screenshot、frontend log 和 backend log。需要检查 Tauri backend 时，通过 `tauri-plugin-wdio` 执行测试 command 或读取结构化诊断；测试场景仍从用户可观察结果完成最终断言。

`test:desktop:debug` 固定 `maxInstances: 1`，输出 executable PID、data directory、artifact directory 和当前场景。开发者可以在测试 breakpoint 暂停期间使用应用窗口和 WebView DevTools观察状态。

## 隔离环境

每次本地运行创建独立环境：

```text
test-results/desktop/<run_id>/
.tmp/e2e/<run_id>/data/
.tmp/e2e/<run_id>/cache/
.tmp/e2e/<run_id>/runtime/
.tmp/e2e/<run_id>/space/
```

运行器向应用传入 `CCSM_DATA_DIR`、fixture root 和 `run_id`，并记录、清理本次运行创建的进程、WebView、profile 和目录。

同一 workspace 同时保留一个 Desktop E2E session，以避免 executable、display、profile 和端口竞争。调试结束后 runner 执行标准 teardown，并报告残留资源。

## 场景与 selector 规则

- 场景按用户流程命名，Windows 与 Linux 共享同一个 spec。
- selector 使用稳定的 role、label 或 `data-testid`。
- 每个关键操作后等待明确的可观察状态。
- 条件等待负责测试同步；证据动画节奏可以使用短暂延时。
- fixture 使用合成 Space、provider home 和 credential 数据。
- 平台差异放入 screenshot、process 和 display adapter，业务步骤保持共享。

## 本地验收证据

本地 evidence 与 CI 使用相同格式：

```text
manifest.json
result.json
acceptance/<scenario-id>.gif
screenshots/<scenario-id>/<step>.png
logs/
process-cleanup.json
```

普通调试运行默认保留失败证据；`test:desktop:evidence` 为选定场景保留完整 GIF。开发者在推送前打开 GIF，确认画面包含关键输入、状态变化和最终结果。

## CI 失败复现

从 Actions artifact 读取以下信息：

- commit SHA 与平台
- failed scenario 和 checkpoint
- executable/WebView 版本
- fixture/run ID
- frontend/backend/WDIO 日志
- 失败前后的截图或 GIF

切换到相同 commit 后，在对应平台运行同一个 spec：

```powershell
pnpm test:desktop:build
pnpm test:desktop:debug -- --spec <failed-spec>
```

修复完成后先重复单场景，再运行当前平台全部 Desktop Scenarios。提交后的 GitHub Actions 负责 Windows 与 Linux 的最终门禁结果。

## 本地调试验收标准

- 本地 Desktop E2E 通过 `@wdio/tauri-service` embedded provider 启动应用。
- 本地和 CI 共用配置、场景、fixture、selector 和 assertion。
- 开发者能够按 spec 运行、暂停、检查日志并重复执行。
- 每次运行使用隔离 data/profile/runtime 目录并完成进程清理。
- evidence 模式生成与 CI 相同结构的 GIF、截图和结果文件。
