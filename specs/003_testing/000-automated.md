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
initialize failure evidence
→ checkout
→ install pinned toolchains and locked dependencies
→ pnpm check
→ pnpm test
→ pnpm test:desktop:build
→ test E2E-only backend
→ pnpm test:desktop:ci
→ finalize acceptance evidence
→ upload artifact
→ report job status
```

`pnpm test:desktop:build` 构建启用 `e2e` feature 的平台 executable。`pnpm test:desktop:ci` 使用同一份 WDIO 配置和同一组 Desktop Scenarios。Linux job 在虚拟 display 中运行应用，Windows job 在 runner desktop session 中运行应用。

job 开始时创建最小 `workflow-state.json`。测试步骤失败后，证据整理和上传步骤使用 `if: always()` 继续执行。finalizer 将 workflow 状态、display cleanup 和 runner 结果汇总为一个最终结论；证据生成、teardown 或 artifact 上传失败也会使该平台 job 失败。

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

每次运行复制一份独立 E2E executable 到临时 ownership root。应用、runtime shim、Hook reporter、watchdog 与 provider fixture 都从该目录启动。teardown 结束后按 ownership root 检查完整进程集合，记录 graceful cleanup、强制回收前后的进程信息，并将结果写入 `process-cleanup.json`。Linux workflow finalizer 在 `xvfb-run` 返回后把 display 检查写入 `display-cleanup.json`。

## Provider model mock

必需门禁通过 E2E executable 内的 test-only provider mock 运行 Claude、Codex 与 GitHub Copilot。mock executable 继续经过生产 CLI shim、PTY、Hook reporter、native session binding 和 resume 参数组装，并以固定内容代替网络 model 调用。

`CCSM_E2E_MODEL_MOCK_FILE` 指向本次运行的 JSON 配置。测试在发送 prompt 前按 `provider + prompt` 设置返回内容；第二轮响应在 resumed CLI 启动后写入，mock 在 prompt 到达时读取最新配置。`CCSM_E2E_MODEL_MOCK_LOG` 记录 session start、native session ID、resume 状态、prompt 和 response，供断言及 artifact 验收。

Claude mock 从生产 shim 生成的 `--session-id` 建立初始绑定。Codex 与 GitHub Copilot 在首条 prompt 到达时建立初始绑定。三家 provider 的 resume 启动均校验生产 shim 组装的完整参数与已绑定 native session ID 一致；artifact 仅记录会话选择参数。E2E 环境启用严格 Hook reporter，Hook delivery 失败直接使 provider fixture 和场景失败。

门禁包含三条独立场景：

1. 创建 Space、创建 Claude CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。
2. 创建 Space、创建 Codex CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。
3. 创建 Space、创建 GitHub Copilot CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。

Provider 场景使用 DOM Browser placeholder，保持 embedded driver 对主 WebView 的控制；对应测试仍创建生产默认 Browser Tab 数据。native Browser child 的 bounds、visibility 与 lifecycle 验收列入后续独立平台套件。

## 自动断言

当前自动门禁覆盖：

1. executable 成功启动且主 WebView ready。
2. 用户通过可见目录选择、CLI 按钮与真实 WebDriver keyboard action 创建 Space 和三种 CLI。
3. 每种 CLI 收到按 prompt 动态配置的固定 model response。
4. Stop 后再次 Start 使用同一 native session，第二轮 prompt 正常返回。
5. 应用退出后，本次测试 ownership root 下的进程与资源完成清理。

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
display-cleanup.json
credential-scan.json
workflow-state.json
```

`manifest.json` 记录 commit SHA、workflow run、平台、架构、应用版本、WebView 版本、最终 gate 状态、cleanup 状态、场景列表以及文件 SHA-256。`result.json` 记录每个场景的 ID、passed/failed、持续时间和失败步骤。runner 或 teardown 失败会追加结构化 runner failure，确保 job、result、manifest 和 Actions Summary 使用同一个最终结论。

GIF 由场景中的有名称验收 checkpoint 生成，按操作顺序展示启动、关键输入、状态变化和最终结果：

- DOM 场景使用 WebDriver screenshot。
- 包含 native child surface 的场景使用完整应用窗口 screenshot。
- GIF 使用固定尺寸和低帧率，画面标记平台、场景名称及 checkpoint。
- 失败场景保留失败前后的可用画面，并在最后一帧标记失败步骤；GIF 生成错误写入独立诊断文件并保留原始测试错误。

GIF 用于人工观察，WDIO assertion 决定测试结果。截图或 GIF 中使用合成测试数据。上传前对 JSON、JSONL、XML、TXT 与日志去除 NUL，规范化 workspace/temp 路径并清理 token；credential scan 命中会使 gate 失败并写入 `credential-scan.json`。`logs/wdio.log` 是跨平台人工诊断的规范化入口。

## Artifact 上传

artifact 上传使用仓库锁定的 `actions/upload-artifact` 版本，公开仓库的验收证据保留 7 天：

```yaml
- name: Upload desktop E2E evidence
  if: always()
  uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
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
- `workflow_dispatch`：通过 `platform = all/windows/linux` 和 `scenario = all/claude/codex/ghcp` 指定诊断范围，结果保留相同证据格式。
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
