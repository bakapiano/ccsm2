# 本地桌面测试与调试

本文定义两个本地入口：Microsoft [`playwright-cli`](https://github.com/microsoft/playwright-cli) 连接运行中的 dev WebView，完成交互式检查；WebdriverIO、`@wdio/tauri-service` 和 embedded provider 运行可重复 Desktop E2E，并与 GitHub Actions 共用 scenarios 和 E2E executable。

## 两个本地循环

日常编写 TypeScript、CSS 和 Rust 时使用：

```powershell
pnpm dev
```

该命令提供 Tauri dev 与 Vite HMR。Playwright CLI 连接这个正在运行的 WebView。需要执行可重复断言、复现 CI 场景或调试测试时使用 Desktop E2E 入口：

```powershell
pnpm test:desktop:build
pnpm test:desktop
```

前者构建启用测试插件的 E2E executable，后者按专用 npm lockfile 准备三家真实 CLI、启动 loopback model API stub，再通过 `@wdio/tauri-service` 启动应用并执行场景。

需要验证当前 CCSM wrapper 与门禁固定版本真实 CLI 的兼容性时运行：

```powershell
pnpm test:desktop:build
pnpm test:provider-cli-contract
```

该命令从 npm 官方 registry 按专用 lockfile 下载当前平台的 Claude Code、Codex 与 GitHub Copilot CLI，校验 integrity、版本、resume 接口和 wrapper 参数。三家真实 CLI 使用 loopback model API 完成对话与 Hook；Claude 和 GitHub Copilot 同时执行 native session resume。执行环境使用隔离 HOME、合成 API key 和关闭的外部模型网络。默认安装目录位于 `test-results` 并在完成后清理，结果保存在 `test-results/provider-cli-contract/<platform>/provider-cli-contract.json` 与同级 `logs/`。

## 使用 Playwright CLI 连接 dev WebView

交互检查统一使用 Microsoft 官方 `playwright-cli`。开始前检查命令：

```powershell
Get-Command playwright-cli -ErrorAction SilentlyContinue
```

Linux/macOS 使用：

```bash
command -v playwright-cli
```

命令缺失时，向用户提示官方安装命令，由用户确认并执行：

```powershell
npm install -g @playwright/cli@latest
playwright-cli --help
```

终端一启动开发实例并保持运行：

```powershell
pnpm dev
```

主 WebView2 的 dev 配置开放 CDP `9226`。终端二确认 endpoint ready，然后创建具名连接：

```powershell
Invoke-RestMethod http://127.0.0.1:9226/json/version
playwright-cli -s=ccsm-dev attach --cdp=http://127.0.0.1:9226
```

连接后使用同一个 session 检查页面：

```powershell
playwright-cli -s=ccsm-dev tab-list
playwright-cli -s=ccsm-dev snapshot --depth=4
playwright-cli -s=ccsm-dev find "New Tab"
playwright-cli -s=ccsm-dev click <ref>
playwright-cli -s=ccsm-dev console
playwright-cli -s=ccsm-dev screenshot
```

`snapshot` 或 `find` 返回当前页面的 element ref，后续 `click`、`fill`、`hover` 使用该 ref。检查完成后 detach，Tauri dev 继续运行：

```powershell
playwright-cli -s=ccsm-dev detach
```

Playwright CLI session 负责开发实例的交互探索、DOM 状态确认、console/network 检查和临时截图。稳定复现步骤进入下方 WDIO Desktop Scenario，形成可重复断言。

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
CCSM_E2E_SCENARIO=<provider> pnpm test:desktop run claude/codex/ghcp scenario
pnpm test:desktop:debug -- --spec <file> run one spec with debug logging
pnpm test:desktop:evidence -- --spec <file> run one spec in evidence mode
pnpm test:provider-cli-contract             download and verify pinned real CLIs
```

CI 的 `pnpm test:desktop:ci` 调用同一 runner，并增加 CI reporter、固定 timeout 和 artifact 输出路径。

PowerShell 运行单个 provider 场景：

```powershell
$env:CCSM_E2E_SCENARIO = "codex"
pnpm test:desktop
Remove-Item Env:CCSM_E2E_SCENARIO
```

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

每次本地运行在操作系统临时目录创建 ownership root：

```text
test-results/desktop/<run_id>/
test-results/.ccsm-e2e-<platform>-*/app-data/
test-results/.ccsm-e2e-<platform>-*/spaces/
test-results/.ccsm-e2e-<platform>-*/model-stub.json
```

两平台运行器直接启动当前 job 的构建产物并记录进程基线，保留 WebView 资源路由。运行器向应用传入 `CCSM_DATA_DIR`、fixture root 和 `run_id`；E2E runtime shims 进入隔离 data root，runner 按 ownership root 与新增 PID 记录、清理 app、shim、provider、watchdog、WebView、profile 和目录。

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

每种运行模式都保留结构化结果、checkpoint 截图和完整 GIF。`test:desktop:evidence` 用于显式标记人工验收运行。开发者在推送前打开 GIF，确认画面包含关键输入、状态变化和最终结果。

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
