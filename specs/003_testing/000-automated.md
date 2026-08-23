# GitHub Actions 测试门禁

本文定义 CCSM 公开仓库的必需测试门禁。每个 Pull Request 在 GitHub 托管的 Windows 与 Linux 桌面 runner 上分别构建并启动真实 Tauri executable，通过 [`@wdio/tauri-service`](https://v2.tauri.app/develop/tests/webdriver/) 操作主 WebView，并发布可供 owner 验收的临时静态报告、GIF 与测试结果。

## 合并条件

受保护分支配置以下必需检查：

- `Verify (windows-2022)`
- `Verify (ubuntu-24.04)`
- `desktop-e2e-windows`
- `desktop-e2e-linux`

四个检查全部成功后，owner 检查两个平台的验收证据并执行合并。自动断言负责确定行为正确性，人工验收负责检查布局、交互过程和平台视觉结果。

本阶段门禁矩阵固定为 Windows 与 Linux，两个平台具有同等门禁权重。macOS 是目标平台，当前 Desktop Gate 状态为 Planned；后续 macOS job 复用相同 harness、scenarios 和 artifact contract。

## Workflow 拓扑

```text
Pull Request / main push
        │
        ├── Verify (windows-2022 / ubuntu-24.04)
        │       └── formatting + contracts + check + unit/integration tests
        │
        ├── desktop-e2e-windows ── windows-2022
        │       ├── test E2E-only backend
        │       ├── build Windows E2E executable
        │       ├── pinned real-provider CLI contract
        │       ├── WDIO desktop scenarios
        │       ├── build/install NSIS A/B E2E packages
        │       ├── Settings signed update + restart reconnect
        │       ├── acceptance GIF + result files
        │       └── upload Actions Artifact (7 days)
        │
        └── desktop-e2e-linux ──── ubuntu-24.04 + virtual display
                ├── test E2E-only backend
                ├── build Linux E2E executable
                ├── pinned real-provider CLI contract
                ├── WDIO desktop scenarios
                ├── build/install DEB + AppImage A/B E2E packages
                ├── Settings signed updates + restart reconnect
                ├── acceptance GIF + result files
                └── upload Actions Artifact (7 days)

completed pull_request CI
        └── trusted workflow_run publisher
                ├── bind run head SHA to same-repository PR
                ├── validate manifest, size, SHA-256, media and credential scan
                ├── render all job/platform/scenario results
                ├── publish /e2e/pr/<number>/
                └── update the stable PR comment
```

Verify matrix 与两个 Desktop E2E jobs 并行执行。Verify matrix 负责静态检查和默认 feature 测试；每个 Desktop job 独立完成依赖安装、E2E 构建、应用启动、场景、teardown 和证据上传，并消费本 job 构建的产物。

## 平台 job 契约

| Job                   | Runner         | 显示环境                  | 必需输出                     |
| --------------------- | -------------- | ------------------------- | ---------------------------- |
| `desktop-e2e-windows` | `windows-2022` | runner desktop session    | test result、GIF、截图、日志 |
| `desktop-e2e-linux`   | `ubuntu-24.04` | Xvfb/虚拟 display session | test result、GIF、截图、日志 |

每个 job 按固定顺序执行：

```text
initialize failure evidence
→ checkout
→ install pinned toolchains and locked dependencies
→ test E2E-only backend
→ pnpm test:desktop:build
→ pnpm test:provider-cli-contract
→ pnpm test:desktop:ci
→ build signed A/B E2E platform packages
→ install A and drive Settings update to B
→ reconnect after restart and verify B
→ finalize acceptance evidence
→ upload artifact
→ report job status
```

`pnpm test:desktop:build` 构建启用 `e2e` feature 的平台 executable。E2E-only Cargo tests 先执行，平台 build 最后写入带 Tauri E2E config overlay 的 executable。`pnpm test:provider-cli-contract` 使用该 executable 的生产 wrapper 验证固定版本真实 CLI。`pnpm test:desktop:ci` 使用同一份 WDIO 配置和同一组 Desktop Scenarios。随后同一 job 使用临时 updater key、loopback 多 endpoint 和 E2E config 构建 A/B 安装包；Windows 从 Settings 完成 NSIS A→B，Linux 从 Settings 分别完成 DEB 与 AppImage A→B。每条链路在自动重启后重连 embedded WebDriver，并验证 B 版本和持久化数据。tag release workflow 对 production bundles 执行当前候选 package gate。

job 开始时创建最小 `workflow-state.json`。测试步骤失败后，证据整理和上传步骤使用 `if: always()` 继续执行。finalizer 将 workflow 状态、display cleanup 和 runner 结果汇总为一个最终结论；证据生成、teardown 或 artifact 上传失败也会使该平台 job 失败。

Ubuntu job 将 runner APT mirror list 固定为 Ubuntu 官方 HTTPS archive。依赖准备依次执行带超时与重试的索引更新、仅下载 deb archive、本地 dpkg 安装；网络 attempt、选定镜像和退出码进入 Actions 日志，单个依赖准备 step 最长运行 10 分钟。`pnpm test` 覆盖镜像选择、阶段拆分、瞬时失败重试与重试耗尽。

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

公开仓库必需门禁的全部输入由固定版本 provider CLI、确定性 model response、合成 API key 和隔离目录组成。真实账户验收归属受保护的专项 workflow。

Windows 与 Linux 都直接启动本 job 构建的 executable，保留不同 WebView 版本的资源路由；运行前记录同路径进程基线。E2E feature 将 runtime shim 放入隔离 data root。Space、provider HOME 与工作目录位于 Git repository 外侧的同卷 sibling runtime，`GIT_CEILING_DIRECTORIES` 将 discovery 边界固定在该 runtime。teardown 结束后按 ownership root、显式 child PID、源 executable 新增 PID 与进程命令行检查完整进程集合，记录 graceful cleanup、强制回收前后的信息，并写入 `process-cleanup.json`。Linux workflow finalizer 在 `xvfb-run` 返回后把 display 检查写入 `display-cleanup.json`。

## 真实 Provider CLI 与 model API stub

必需门禁启动 npm lockfile 固定的 Claude Code、Codex 与 GitHub Copilot CLI 原生 executable。三家 CLI 都经过生产 CLI shim、PTY、Hook reporter、native session binding 和 resume 参数组装。runner 上的 loopback HTTP server 实现 Anthropic Messages 与 OpenAI Responses 协议，并向真实 CLI 返回确定性 model response。

`CCSM_E2E_MODEL_STUB_FILE` 指向本次运行的 JSON 配置。测试在发送 prompt 前按 `provider + prompt` 设置返回内容；第二轮响应在 resumed CLI 启动后写入，stub 在 HTTP request 到达时读取最新配置。`CCSM_E2E_MODEL_STUB_LOG` 记录 provider、model、prompt、response 和 API path，供断言及 artifact 验收。

Claude 从生产 shim 生成的 `--session-id` 建立初始绑定。Codex 与 GitHub Copilot 通过真实 `SessionStart` Hook 建立绑定。Stop/Start 后的 CLI 使用生产 resume 参数恢复同一 native session；恢复后的 TUI 必须显示首轮 prompt/response，第二轮 API request 必须携带首轮 inline history 或引用首轮唯一 response ID。E2E 环境启用严格 Hook reporter，Hook delivery 失败直接使场景失败。

## 固定版本 Provider CLI contract

每个平台 job 在 Desktop Scenarios 前从 npm 官方 registry 安装测试专用的 Claude Code、Codex 与 GitHub Copilot CLI。`apps/desktop/e2e/provider-cli-contract/package.json` 固定顶层版本，`package-lock.json` 固定平台包、下载地址和 integrity。`npm ci --ignore-scripts` 执行完整性校验并选择当前 runner 的原生 x64 包。

contract 对每家 provider 执行：

1. 原生 executable 的版本检查。
2. `resume`、session 与 Hook/plugin 参数接口检查。
3. argv-capture executable 对 CCSM 生产 `ccsm-provider` wrapper 的 cold-start 完整参数做精确断言。
4. argv-capture executable 对生产 wrapper 注入的 provider session selection、Hook settings/plugin 与 native session ID 做精确断言。
5. Claude 真实 CLI 通过本地 Anthropic stub 完成 cold prompt、固定 native session resume、第二轮 prompt 与真实 Hook delivery。
6. Codex 真实 CLI 通过本地 Responses API stub 完成 cold prompt、native session resume、第二轮 prompt 与 `source=resume` Hook delivery。
7. GitHub Copilot 真实 CLI 通过 BYOK/offline 本地 Responses API 完成 cold prompt、固定 native session resume、第二轮 prompt 与真实 Hook delivery。
8. Desktop Codex场景执行真实`/btw`、`/fork`与`/clear`：父native Session ID贯穿side response、返回主线程与cold resume，持久fork和clear分别绑定新native Session ID。
9. Hook payload单测覆盖Claude、Codex、Copilot的snake_case/camelCase ephemeral父子字段，core绑定单测覆盖三家provider的父绑定保持行为与Codex `clear/resume/fork`持久转换。

执行环境使用显式 OS/display allowlist、隔离 HOME 与合成 API key。loopback stub 校验每个模型请求携带合成认证；三家的 model base URL 指向 runner loopback stub，辅助 HTTP 客户端收到 closed-loopback proxy 设置。package lockfile、平台原生版本字符串与 executable SHA-256 共同固定测试字节。真实 CLI executable 位于独立安装目录，工作目录位于 Git repository 外的 sibling runtime，job 生命周期负责清理；artifact 保存 `provider-cli-contract.json` 与 model-stub JSONL，其中包含固定版本、实际版本、二进制 SHA-256、模型请求与逐项结果。

该 contract 提供真实发行版的参数兼容证据。下方三条 Desktop Scenarios 提供确定性的完整对话、Hook、session binding 与 resume 行为证据。受保护的手动或 nightly workflow 管理需要真实账户的 provider 对话。

Provider门禁包含三条独立场景：

1. 创建 Space、创建 Claude CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。
2. 创建 Space、创建 Codex CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。
3. 创建 Space、创建 GitHub Copilot CLI、发送 prompt、Stop、Start、验证同一 native session resume，再发送第二轮 prompt。

Markdown场景覆盖编辑、预览与保存。Sidebar场景覆盖折叠、刷新恢复与展开。Terminal Clipboard场景覆盖鼠标拖选、`Ctrl+C`复制、`Ctrl+V`回贴、窗口失焦时丢失modifier keyup后的Win32输入状态恢复和空选区`Ctrl+C`中断PTY任务。Terminal Renderer场景覆盖跨Space保留终端时的render loop数量上限与返回后的画面恢复。

Desktop E2E使用DOM Browser placeholder，保持embedded driver对主WebView的控制；Markdown场景显式创建Browser Tab并验证右侧Dock落位。native Browser child的bounds、visibility与lifecycle由独立平台套件验收。

## 自动断言

当前自动门禁覆盖：

1. executable 成功启动且主 WebView ready。
2. 用户通过可见目录选择、CLI 按钮与真实 WebDriver keyboard action 创建 Space 和三种 CLI。
3. 新Space呈现左侧Shell、右侧Files与Changes，应用外壳内容延伸到窗口底部；新建Browser与File Editor进入右侧Dock。
4. 每种 CLI 收到按 prompt 动态配置的固定 model response。
5. Stop 后再次 Start 使用同一 native session，第二轮 prompt 正常返回。
6. 三家固定版本真实 CLI 接受当前 resume 接口与生产 wrapper 参数。
7. 应用退出后，本次测试 ownership root 下的进程与资源完成清理。
8. 用户通过侧栏右下按钮折叠侧栏，40px窄栏仅显示展开按钮；再次点击后恢复展开宽度与导航内容。

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
log-diagnostics.json
provider-cli-contract.json
workflow-state.json
```

`manifest.json` 记录 commit SHA、workflow run、平台、架构、应用版本、WebView 版本、最终 gate 状态、cleanup 状态、场景列表以及文件 SHA-256。`result.json` 记录每个场景的 ID、passed/failed、持续时间和失败步骤。`log-diagnostics.json` 分别计数 Windows embedded driver 的 nullable-u32 warning 与 Linux Xvfb 的 AT-SPI/DRI3 warning，并让未登记的 frontend/backend error 进入失败结果。runner 或 teardown 失败会追加结构化 runner failure，确保 job、result、manifest 和 Actions Summary 使用同一个最终结论。

GIF 由场景中的有名称验收 checkpoint 生成，按操作顺序展示启动、关键输入、状态变化和最终结果：

- DOM 场景使用 WebDriver screenshot。
- 包含 native child surface 的场景使用完整应用窗口 screenshot。
- GIF 使用固定尺寸和低帧率，画面标记平台、场景名称及 checkpoint。
- 失败场景保留失败前后的可用画面，并在最后一帧标记失败步骤；GIF 生成错误写入独立诊断文件并保留原始测试错误。

GIF 用于人工观察，WDIO assertion 决定测试结果。截图或 GIF 中使用合成测试数据；上传前对 JSON、JSONL、XML、TXT 与日志去除 NUL，规范化 workspace/temp 路径并清理 token；credential scan 命中会使 gate 失败并写入 `credential-scan.json`。`logs/wdio.log` 是跨平台人工诊断的规范化入口。

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

## PR静态报告发布

每次`pull_request` CI完成后，独立`workflow_run`发布器从默认分支加载受信任workflow与report generator。发布器通过GitHub API将run head SHA唯一绑定到同仓库open PR，并按`run ID + attempt + platform`下载Windows/Linux evidence。PR workflow保持`contents: read`；发布器job持有Pages snapshot与PR评论所需写权限。

上游Artifact作为外部数据处理。下载前限制匹配artifact数量和单项archive尺寸；下载目录位于`runner.temp`。生成器对manifest执行schema与路径检查，重新计算公开文件的byte size和SHA-256，验证PNG/GIF signature，并解析credential scan、cleanup、log diagnostics、JUnit、provider package与contract checks。公开媒体由通过credential scan的PNG/GIF组成。页面HTML、CSS、JSON与Content Security Policy由默认分支生成器创建。Actions Artifact管理原始日志、provider输出、完整manifest和JUnit XML。

静态报告使用稳定地址：

```text
https://<owner>.github.io/<repository>/e2e/pr/<number>/
```

报告首页汇总触发运行的全部GitHub Actions jobs及steps。平台区域展示workflow step outcomes、evidence health、固定CLI版本与integrity、全部provider contract checks、Desktop scenario状态与耗时，以及Claude、Codex、GHCP、Markdown、Sidebar、Settings、CLI Theme、Terminal Clipboard和Terminal Renderer场景的acceptance GIF与checkpoint PNG。新提交更新相同PR目录与同一条PR评论。

`gh-pages`保存当前active PR报告集合，并通过串行concurrency group发布单一orphan snapshot commit。`pull_request_target: closed`从默认分支执行对应目录清理；每日prune以GitHub API返回的open PR集合刷新站点。报告发布job提供人工验收导航，四个原生required checks继续提供合并结论。

首次启用由owner使用成功CI run的同格式Artifact和当前分支中的受信任生成器创建orphan snapshot，再将GitHub Pages source绑定到`gh-pages / root`。默认分支接管后续自动发布与清理。

## 人工验收流程

Owner在合并PR前完成：

1. 确认 Verify matrix、`desktop-e2e-windows` 与 `desktop-e2e-linux` 均成功。
2. 从PR评论打开对应commit的Pages静态报告。
3. 检查两个平台的workflow steps、evidence health与预期场景集合。
4. 查看全部`acceptance/*.gif`与关键checkpoint PNG，检查操作、布局和最终状态。
5. 对涉及native surface的改动检查对应完整窗口截图。
6. 需要深度诊断时从同一workflow run下载原始artifact。
7. 记录owner验收结论或指出需要重跑的场景。

PR Pages评论与owner结论是人工验收记录；四个required status checks是自动门禁记录。重新推送commit后，稳定报告地址更新为新workflow run的证据。

## Workflow 触发与资源控制

- Pull Request：运行两个必需平台 job。
- `main` push：运行两个平台 job，验证合并结果。
- `workflow_dispatch`：通过 `platform = all/windows/linux` 和 `scenario = all/claude/codex/ghcp/markdown/sidebar/settings/theme/terminal/renderer` 指定诊断范围，结果保留相同证据格式。
- 同一 PR 的旧 commit 运行通过 concurrency group 取消。
- job 和单场景设置明确 timeout。
- artifact 使用 7 天 retention，为 PR 审查和跨时区验收提供完整窗口。

## 门禁验收标准

门禁实现完成时必须满足：

- Verify matrix 与 Windows/Linux Desktop E2E 在 GitHub Actions 中显示为四个 required checks。
- 两个平台都通过 `@wdio/tauri-service` embedded provider 启动真实 executable。
- 两个平台都通过 lockfile 安装并验证三家固定版本真实 CLI。
- 本地与 CI 调用同一份 WDIO 配置和 Desktop Scenarios。
- 每个平台运行都生成结构化测试结果与可播放 GIF。
- finalizer 在任一前置步骤失败时从零生成 `result.json`、manifest、credential scan、process/display cleanup 状态与 provider contract 状态；失败运行仍上传完整诊断证据并保留失败状态。
- artifact 的 `retention-days` 为 `7`。
- branch protection 同时要求 Verify matrix、两个平台 E2E 检查、resolved conversations 和 administrator enforcement。
