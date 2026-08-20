# 桌面安装与应用内升级

本规格定义 CCSM 本期的安装与应用内升级实现。交付平台为 Windows 11 x64 和 Ubuntu 24.04 x86_64，产物为 Windows NSIS、Linux DEB 与 Linux AppImage。

相关约束见[资源清理](../002_runtime/003-resource-cleanup.md)、[跨平台能力](../001_architecture/001-cross-platform.md)和[Data / IPC](../005_data/000-persistence-ipc.md)。

## 交付结果

- Windows 用户通过 NSIS 安装，Ubuntu 用户通过 DEB 安装，AppImage 提供可写目录中的独立可执行文件。
- CCSM 启动后检查一次更新，用户也可以手动执行“检查更新”。
- 发现新版本后显示版本号、发布时间、release notes 和“升级并重启”。
- 国内源、全球源和 GitHub 源按顺序提供清单与更新包。
- 下载、签名验证、安装、资源清理和重启由一个按钮触发。
- 安装过程保留 `data.db`、Browser Profile、Space 配置和 cache。

## 安装包与位置

| 平台        | 安装产物         | 更新目标键              | 安装位置                | 更新方式           |
| ----------- | ---------------- | ----------------------- | ----------------------- | ------------------ |
| Windows x64 | NSIS `setup.exe` | `windows-x86_64-nsis`   | NSIS `InstallLocation`  | Passive 安装并重启 |
| Ubuntu x64  | `.deb`           | `linux-x86_64-deb`      | `dpkg` package database | `dpkg -i` 后重启   |
| Linux x64   | `.AppImage`      | `linux-x86_64-appimage` | 当前 AppImage 路径      | 原位替换后重启     |

Tauri bundle 使用以下固定身份：

```text
productName = CCSM
identifier  = dev.ccsm.desktop
binary      = ccsm-desktop
```

Windows NSIS 使用 `currentUser` 模式，默认安装到 `%LOCALAPPDATA%\CCSM`。NSIS 把实际目录写入卸载注册表项的 `InstallLocation`，升级时读取并沿用该目录。

DEB 的文件位置由 package metadata 和 `dpkg` 管理。AppImage 使用 Tauri 解析出的当前 AppImage 路径，并在同一挂载点创建临时备份后替换文件。

程序文件与用户数据使用独立目录。NSIS、DEB 和 AppImage 更新步骤操作程序文件，`PlatformPaths` 继续解析既有 per-user data 目录。

Windows bundle 保持 `conpty/`、manifest、license 和 notices 与可执行文件的相对布局。Linux 安装测试从 `.desktop` 启动程序，并验证 provider CLI resolution。

正常桌面构建启用 `tauri-plugin-single-instance`。第二次启动把已有主窗口带到前台。安装器进程检查作为 Windows 手工安装时的运行检测。

## 最小实现边界

更新代码集中在 desktop host：

```text
apps/desktop/src-tauri/updates.rs
├─ check_update
├─ download_update
├─ install_update
└─ PendingUpdate

apps/desktop/src
└─ CcsmDesktopClient.updates
   ├─ check()
   ├─ download(updateId, onProgress)
   └─ install(updateId)
```

`PendingUpdate` 直接放入现有 `DesktopState`，保存当前候选项、来源和可选的已验证 bytes。进程结束时释放该状态。一个 mutex 串行化 check、download 和 install。

Rust 定义 `UpdateInfo` 与 `UpdateProgress` DTO 并生成 TypeScript 类型。raw `invoke` 与 Tauri `Channel` 留在 desktop transport adapter。前端使用简单的 `idle / checking / available / downloading / ready / installing / error` UI 状态。

主窗口 bootstrap 完成约 5 秒后调用一次 `check()`。标题栏或 About 区域提供手动检查入口。版本判断使用 SemVer，远端版本大于当前版本时返回 `UpdateInfo`。开发构建默认关闭自动检查，E2E 构建注入测试 endpoint 和 public key。

## 多更新源

release config 保存一组有序 endpoint：

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://updates-cn.example.com/latest.json",
        "https://updates-global.example.com/latest.json",
        "https://github.com/bakapiano/ccsm2/releases/download/updater-beta/latest.json"
      ],
      "pubkey": "<embedded updater public key>",
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

示例 DNS 名称在部署时替换为实际对象存储或 CDN 域名。`updates.rs` 对每个 endpoint 单独调用 Tauri updater，使清单和 artifact 共用同一套后备顺序：

1. 每个 endpoint 使用 8 秒超时。
2. 网络、TLS、HTTP 和 JSON 错误进入日志，然后检查下一个 endpoint。
3. 第一份有效清单或有效 `204 No Content` 结束本次检查。
4. 清单按当前 bundle type 读取三个精确目标键之一。
5. artifact 下载失败时，从后续 endpoint 查找版本号和目标键完全相同的 artifact 并继续下载。
6. 所有 endpoint 均失败时，手动检查显示聚合错误，自动检查保持安静。

每个镜像的 manifest 把 URL 指向该镜像自己的 artifact。三处 artifact bytes 与 updater signature 保持一致。release workflow 先完成全部 artifact 上传和 hash 验证，再更新各镜像的 `latest.json`。

## 更新清单

每个 endpoint 提供相同版本的静态 JSON：

```json
{
  "version": "0.1.0-beta.7",
  "notes": "Release notes in Markdown.",
  "pub_date": "2026-08-20T02:00:00Z",
  "platforms": {
    "windows-x86_64-nsis": {
      "url": "https://mirror.example.com/0.1.0-beta.7/CCSM-setup.exe",
      "signature": "<signature>"
    },
    "linux-x86_64-deb": {
      "url": "https://mirror.example.com/0.1.0-beta.7/CCSM_amd64.deb",
      "signature": "<signature>"
    },
    "linux-x86_64-appimage": {
      "url": "https://mirror.example.com/0.1.0-beta.7/CCSM_amd64.AppImage",
      "signature": "<signature>"
    }
  }
}
```

manifest generator 校验版本、三个目标键、URL 和签名。`version` 与 Cargo、Tauri 和 package manifests 使用同一个 release version。

## 一键升级流程

```text
download_update with progress
→ verify updater signature
→ run existing dirty-editor and close preflight
→ wait for deletion queue and flush layout
→ install_update
→ DesktopState.shutdown()
→ restart installed executable
```

下载期间 CCSM 保持可用。下载完成后运行现有关闭预检。用户取消关闭时，已验证 bytes 留在 `PendingUpdate`，下一次点击直接进入预检和安装。

Windows 把签名验证后的 NSIS bytes 写入临时 `.exe`，启动 breakaway helper 后调用幂等 `DesktopState.shutdown()` 并退出。helper 留出进程交接窗口，使用 `/P /UPDATE` 让 NSIS 完成运行检测与安装，再从原安装路径启动新版本。

DEB 先验证 package 格式，再通过 `pkexec`、图形 sudo 或终端 sudo 执行 `dpkg -i`。AppImage 保留原权限，在替换失败时恢复临时备份。Linux 安装成功后执行同一 shutdown，再 relaunch 当前路径。

shutdown 依照资源清理规格关闭 native WebViews、Browser Profile、CLI process trees、PTY threads、HookEndpoint、background tasks 和 `data.db`。下载、签名、权限或安装错误进入 `error`，当前程序继续运行并提供“重试”。

## 签名与发布

Tauri updater public key 编译进应用。private key 与密码保存在 GitHub Actions release environment secrets。CI 为每个 updater artifact 生成 `.sig`，客户端安装前强制验证签名。

Windows Authenticode 与 Tauri updater signature 分别通过 release gate。手动下载产物同时发布 SHA-256、`SHA256SUMS.txt` 和 GitHub artifact attestation。所有正式 endpoint 和 artifact URL 使用 HTTPS。

tag release workflow 执行：

1. 校验 tag、version manifests 与 main ancestry，并通过现有 quality gate。
2. Windows 构建并签名 NSIS；Ubuntu 构建 DEB、AppImage 和 updater artifacts。
3. 验证 bundle 内容、ConPTY 资源、package metadata、SHA-256 和 updater signature。
4. 上传 versioned artifacts 到 GitHub Release 和全部镜像。
5. 从镜像读取 artifact，确认 hash 与签名。
6. 生成各镜像的 `latest.json`，最后执行原子发布。

## 线上 CI 安装与升级 E2E

PR 的 `desktop-e2e-windows` 与 `desktop-e2e-linux` 使用 Cargo `e2e` feature 和共享 WDIO Settings 场景，验证齿轮入口、Modal、Light/Dark、Check for updates、焦点恢复和资源清理。随后同一 job 使用临时 updater key 构建当前版本 A 与下一 prerelease B，并启动三个 loopback endpoint：首个 endpoint 返回连接错误，第二个提供有效 manifest 与失败 artifact，第三个提供同版本有效 manifest、签名和 artifact。

安装升级场景从 A 安装包启动真实应用，通过 WebDriver 打开 Settings、检查 B、下载签名 artifact 并点击“升级并重启”。runner 观察 A 进程与 WebDriver session 退出，等待 B 在同一安装位置自动重启，再建立 B 的 embedded WebDriver session，验证 B 版本、同一 `data.db`、隔离数据 sentinel、最新版本状态和 endpoint 请求顺序。Windows 记录自动重启 B 的 PID、路径与命令行后正常关闭该实例，再从同一安装位置启动 WebDriver 验证会话；Linux 直接连接重启实例并额外验证主题持久化。Windows 执行 NSIS A→B；Linux 分别执行 DEB A→B 与 AppImage A→B。

GitHub Windows runner 使用 job-owned E2E handoff：应用输出已验证 NSIS 路径、原安装路径和固定参数后完成 shutdown；外层 runner 校验 handoff bytes 与签名候选 artifact 的 SHA-256 一致，再执行 `/P /UPDATE /R`。该边界让安装器留在 Actions job 生命周期内，并保留 Settings 检查、下载、签名验证、应用退出、真实安装和自动重启的完整断言。

tag release workflow 在 GitHub-hosted `windows-2022` 与 `ubuntu-24.04` runner 构建 production bundle，并在发布 artifact 前执行 package gate：

- Windows runner 首先拒绝任何预存的 `ccsm-desktop` 进程，随后静默安装 NSIS，读取注册表 `InstallLocation`，验证 executable 与 ConPTY 布局并启动应用。测试保持该实例运行，再以 `/P /UPDATE /R` 执行 Passive update，确认原 PID 退出、新 PID 从同一安装目录启动，最后正常关闭并卸载。
- Ubuntu runner 校验 SHA-256，通过 `dpkg -i` 安装 DEB并在 Xvfb 启动应用，再次执行 `dpkg -i` 验证 package upgrade 后卸载。AppImage 放在可写测试目录，通过 FUSE 启动真实文件。脚本等待测试进程完成 reaping，并拒绝持续存活的进程。

PR updater gate 使用 A/B 产物完成 fresh install、签名验证、多源回退、应用内安装和重启验证。tag package gate 使用当前候选产物验证 installer install mode。Rust tests 覆盖 endpoint 配置与 progress DTO，manifest tests 覆盖三个签名 artifact，component tests 覆盖检查、下载、预检和安装状态。WDIO 结果、安装日志、截图、进程清理证据和 package metadata 作为 7 天 artifact 上传。

## 完成条件

- Windows NSIS、Ubuntu DEB 和 Linux AppImage 均在 GitHub-hosted PR runner 中完成 A→B 应用内签名升级、自动重启、版本验证与清理。
- Windows 与 Linux updater E2E 均覆盖 endpoint 检查回退和同版本 artifact 下载回退。
- 任一更新源连接失败时，客户端使用下一 endpoint 的同版本 artifact。
- 安装后的 Windows 保持 ConPTY 布局，Linux desktop launch 保持 provider CLI resolution。
- updater UI 通过 `CcsmDesktopClient`，raw Tauri transport 保持在 transport adapter。

## 实施顺序

1. 启用 Tauri bundle，产出 NSIS、DEB、AppImage 与 updater artifacts。
2. 增加 `updates.rs`、三个 commands、generated DTO 和 `CcsmDesktopClient.updates`。
3. 接入检查提示、下载进度、关闭预检、平台安装、shutdown 和 relaunch。
4. 接入签名、manifest generator、多镜像发布和线上 package/update E2E。

## 实现参考

- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri AppImage](https://v2.tauri.app/distribute/appimage/)
