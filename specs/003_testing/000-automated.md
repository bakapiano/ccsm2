# GitHub Actions 测试门禁

本文定义 CCSM 公开仓库的必需测试门禁。每个 Pull Request 在 GitHub 托管的 Windows 与 Linux 桌面 runner 上分别构建并启动真实 Tauri executable，通过 [`@wdio/tauri-service`](https://v2.tauri.app/develop/tests/webdriver/) 操作主 WebView，并上传可供 reviewer 验收的 GIF 与测试结果。

## 合并条件

受保护分支配置以下必需检查：

- `desktop-e2e-windows`
- `desktop-e2e-linux`

两个检查全部成功后，reviewer 检查两个平台的验收证据并批准 PR。自动断言负责确定行为正确性，人工验收负责检查布局、交互过程和平台视觉结果。

本阶段门禁矩阵固定为 Windows 与 Linux，两个平台具有同等门禁权重。macOS 是目标平台，当前 Desktop Gate 状态为 Planned；后续 macOS job 复用相同 harness、scenarios 和 artifact contract。

## Workflow 拓扑

```text
Pull Request / main push
        │
        ├── desktop-e2e-windows ── windows-2022
        │       ├── check + unit/integration tests
        │       ├── build Windows E2E executable
        │       ├── WDIO desktop scenarios
        │       ├── acceptance GIF + result files
        │       └── upload Actions Artifact (7 days)
        │
        └── desktop-e2e-linux ──── ubuntu-24.04 + virtual display
                ├── check + unit/integration tests
                ├── build Linux E2E executable
                ├── WDIO desktop scenarios
                ├── acceptance GIF + result files
                └── upload Actions Artifact (7 days)
```

两个 job 并行执行。每个 job 独立完成依赖安装、构建、应用启动、测试、teardown 和证据上传；每个平台消费本 job 构建的产物。

## 平台 job 契约

| Job                   | Runner          | 显示环境                  | 必需输出                         |
| --------------------- | --------------- | ------------------------- | -------------------------------- |
| `desktop-e2e-windows` | `windows-2022`  | runner desktop session    | test result、GIF、截图、日志     |
| `desktop-e2e-linux`   | `ubuntu-24.04`  | Xvfb/虚拟 display session | test result、GIF、截图、日志     |

每个 job 按固定顺序执行：

```text
checkout
→ install pinned toolchains and locked dependencies
→ pnpm check
→ pnpm test
→ pnpm test:desktop:build
→ pnpm test:desktop:ci
→ finalize acceptance evidence
→ upload artifact
→ report job status
```

`pnpm test:desktop:build` 构建启用 `e2e` feature 的平台 executable。`pnpm test:desktop:ci` 使用同一份 WDIO 配置和同一组 Desktop Scenarios。Linux job 在虚拟 display 中运行应用，Windows job 在 runner desktop session 中运行应用。

测试步骤失败后，证据整理和上传步骤使用 `if: always()` 继续执行。原始测试退出码保持为 job 结果；证据生成、teardown 或 artifact 上传失败也会使该平台 job 失败。

## Desktop 驱动方式

所有 Desktop Scenarios 使用 Tauri 官方推荐的 embedded provider：

```text
WDIO test runner
→ @wdio/tauri-service
→ launch platform executable
→ tauri-plugin-wdio-webdriver
→ main Tauri WebView
→ DOM interaction and assertions
```

共享配置的核心固定为：

```ts
export const config: WebdriverIO.Config = {
  maxInstances: 1,
  services: [
    [
      "tauri",
      {
        appBinaryPath: process.env.CCSM_E2E_APP_BINARY,
        driverProvider: "embedded",
      },
    ],
  ],
};
```

`tauri-plugin-wdio-webdriver` 提供 embedded WebDriver server。`tauri-plugin-wdio` 提供 Tauri command 执行、IPC mocking 以及前后端日志采集。Cargo `e2e` feature 启用两个插件，测试构建包含对应 E2E capability。

Windows 与 Linux 共用场景、selector、assertion、fixture 和 reporter。平台模块负责 executable 路径、显示环境、完整应用窗口截图及进程清理。

## 测试隔离

每次 job 创建独立的：

- `CCSM_DATA_DIR`
- cache/runtime directory
- fixture Space root
- Browser profile
- artifact directory
- `run_id`

公开仓库必需门禁的全部输入由确定性 fixture、虚拟 provider 数据和隔离目录组成。真实 provider credential 归属受保护的专项验收 workflow。

WDIO teardown 关闭应用、native child WebView、PTY、provider fixture 进程和虚拟 display。teardown 结束后执行进程残留检查，并将结果写入 `process-cleanup.json`。

## 自动断言

自动断言是门禁事实源，至少覆盖：

1. executable 成功启动且主 WebView ready。
2. 用户可以创建 Tab、输入内容并看到预期结果。
3. Space、Tab、layout 和 restart recovery 的关键状态一致。
4. Browser/native surface 的 bounds、visibility 和 lifecycle 满足测试契约。
5. 应用退出后，本次测试拥有的进程与资源完成清理。

场景从用户可观察结果断言。内部诊断状态补充失败原因。

## 人工验收证据

每个平台 job 都生成一个独立 artifact：

```text
desktop-e2e-windows-<run_id>
desktop-e2e-linux-<run_id>
```

内部结构固定为：

```text
manifest.json
result.json
junit.xml
acceptance/
  <scenario-id>.gif
screenshots/
  <scenario-id>/<step>.png
logs/
  wdio.log
  frontend.log
  backend.log
process-cleanup.json
```

`manifest.json` 记录 commit SHA、workflow run、平台、架构、应用版本、WebView 版本、场景列表以及文件 SHA-256。`result.json` 记录每个场景的 passed/failed、持续时间和失败步骤。

GIF 由场景中的有名称验收 checkpoint 生成，按操作顺序展示启动、关键输入、状态变化和最终结果：

- DOM 场景使用 WebDriver screenshot。
- 包含 native child surface 的场景使用完整应用窗口 screenshot。
- GIF 使用固定尺寸和低帧率，画面标记平台、场景名称及 checkpoint。
- 失败场景保留失败前后的可用画面，并在最后一帧标记失败步骤。

GIF 用于人工观察，WDIO assertion 决定测试结果。截图或 GIF 中使用合成测试数据，并在写入 artifact 前清理 token、路径和外部内容。

## Artifact 上传

artifact 上传使用 `actions/upload-artifact@v4`，公开仓库的验收证据保留 7 天：

```yaml
- name: Upload desktop E2E evidence
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: desktop-e2e-${{ env.CCSM_E2E_PLATFORM }}-${{ github.run_id }}
    path: test-results/desktop/${{ env.CCSM_E2E_PLATFORM }}/
    retention-days: 7
    compression-level: 0
    if-no-files-found: error
```

PNG、GIF 和 WebM 已经压缩，artifact 使用 `compression-level: 0` 缩短上传时间。Actions run summary 显示平台结果、失败场景和 artifact 名称。

## 人工验收流程

Reviewer 在批准 PR 前完成：

1. 确认 `desktop-e2e-windows` 与 `desktop-e2e-linux` 均成功。
2. 从同一次 workflow run 下载两个 artifact。
3. 打开各平台 `result.json`，确认预期场景完整执行。
4. 查看 `acceptance/*.gif`，检查关键操作、布局和最终状态。
5. 对涉及 native surface 的改动检查对应完整窗口截图。
6. 在 PR review 中批准或指出需要重跑的场景。

PR review 是人工验收记录；两个 required status checks 是自动门禁记录。重新推送 commit 后使用新 workflow run 的证据重新验收。

## Workflow 触发与资源控制

- Pull Request：运行两个必需平台 job。
- `main` push：运行两个平台 job，验证合并结果。
- `workflow_dispatch`：允许指定单个场景进行诊断，结果保留相同证据格式。
- 同一 PR 的旧 commit 运行通过 concurrency group 取消。
- job 和单场景设置明确 timeout。
- artifact 使用 7 天 retention，为 PR 审查和跨时区验收提供完整窗口。

## 门禁验收标准

门禁实现完成时必须满足：

- Windows 与 Linux 在 GitHub Actions 中显示为两个独立 required checks。
- 两个平台都通过 `@wdio/tauri-service` embedded provider 启动真实 executable。
- 本地与 CI 调用同一份 WDIO 配置和 Desktop Scenarios。
- 每个平台运行都生成结构化测试结果与可播放 GIF。
- 失败运行仍上传诊断证据并保留失败状态。
- artifact 的 `retention-days` 为 `7`。
- branch protection 同时要求两个平台检查和 PR review。
