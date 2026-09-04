# Managed Node runtime

## Purpose

Agent Gateway生产bundle依赖Node 22+。`NodeRuntimeManager`在Rust platform层解析系统runtime，并在需要时安装CCSM管理的固定Node 24 LTS。

Node runtime属于应用工具链资源。Gateway与Remote Web静态资源随CCSM版本发布；Provider CLI继续由各Provider安装和认证。

## Resolution

```text
Settings custom path
→ CCSM_NODE_PATH
→ system PATH Node >= 22
→ managed Node 24.11.0
```

每个candidate使用绝对canonical path执行`node --version`。解析结果包含：

```text
ResolvedNodeRuntime {
  executable,
  version,
  target,
  source = custom | environment | system | managed
}
```

GUI进程的PATH discovery结合进程environment与platform用户environment。Settings展示最终path、version和source，并提供Auto、System、Managed与Custom选择。

## Managed layout

```text
CCSM data directory/runtimes/node/
├─ downloads/
│  └─ node-v24.11.0-<target>.<archive>.part
├─ staging/
├─ 24.11.0-<target>/
│  ├─ node[.exe]
│  ├─ LICENSE
│  └─ runtime.json
└─ active.json
```

`runtime.json`记录Node version、target、archive URL、archive SHA-256、executable SHA-256、安装时间和CCSM Gateway protocol range。`active.json`通过原子replace更新。

## Manifest

CCSM source tree保存每个目标的固定manifest：

```json
{
  "version": "24.11.0",
  "target": "win32-x64",
  "archiveType": "zip",
  "url": "https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip",
  "archiveSha256": "...",
  "executablePath": "node.exe",
  "executableSha256": "..."
}
```

manifest进入CCSM signed release。下载使用固定HTTPS URL并设置最大响应大小。企业mirror通过显式受管设置提供等价artifact，并继续匹配固定hash。

## Installation transaction

```text
acquire target singleflight
→ inspect existing runtime.json + executable
→ download archive to .part
→ fsync and verify archive SHA-256
→ extract allowlisted files into unique staging directory
→ verify executable SHA-256 and target
→ execute node --version
→ write runtime.json
→ atomic rename staging to version directory
→ launch Gateway and validate hello
→ atomic update active.json
```

Archive extraction规范化entry path并限制解压总大小、文件数量和single-file大小。Windows提取`node.exe`与license资料；macOS/Linux提取`bin/node`与license资料并设置预期execute permission。

中断下载保留`.part`供maintenance清理。中断解压保留唯一staging directory供清理。完整version directory由发布事务创建，消费者只读取完成的`runtime.json`。

并列版本支持Gateway rollout和rollback。新CCSM版本首次成功握手后切换active；至少保留当前与上一个成功版本，后续maintenance按引用和年龄清理。

## Gateway launch environment

Rust使用ResolvedNodeRuntime的绝对executable启动Gateway bundle，并传入：

```text
CCSM_GATEWAY_BUNDLE
CCSM_REMOTE_WEB_ROOT
CCSM_RUNTIME_REPORT_ENDPOINT
CCSM_GATEWAY_TOKEN
CCSM_REAL_CLAUDE_PATH
CCSM_REAL_CODEX_PATH
CCSM_REAL_COPILOT_PATH
```

启动environment移除`NODE_OPTIONS`与`NODE_PATH`。Provider所需proxy、CA和认证environment根据CCSM/provider策略显式传入。Gateway process working directory指向应用resource root；每个Session cwd通过`session.open`传入。

## Distribution size

当前Windows测量基线：

| Artifact | Approximate size |
| --- | ---: |
| Gateway bundle + Remote Web | 4 MiB installed |
| Node 24 Windows x64 official ZIP | 36 MB download |
| minimal Node executable footprint | 86–90 MiB installed |

macOS/Linux使用对应Node官方target archive。每个release workflow记录archive和executable size，超出预算时要求显式review。

## Failure handling

| Failure | Result |
| --- | --- |
| system Node版本过低 | 选择managed runtime或显示Custom path操作 |
| network/proxy失败 | 保留现有runtime并提供Retry |
| archive hash错误 | 隔离artifact并报告integrity error |
| extraction validation失败 | 清理staging并报告invalid archive |
| node --version失败 | 标记candidate invalid并恢复上一个runtime |
| Gateway hello失败 | 保留active runtime并记录Gateway diagnostic |

## Data and lifecycle

`settings`保存：

```text
node_runtime_source = auto | system | managed | custom
node_custom_path?
```

Node runtime目录由platform maintenance管理。Space删除保留共享runtime。应用卸载遵循installer data-retention policy。Node license与third-party notices进入CCSM distribution notices。

## Acceptance

1. Windows、macOS和Linux解析Node 22+系统runtime。
2. custom path、environment、system和managed precedence具有contract tests。
3. managed install覆盖固定hash、下载中断、Zip Slip、oversize、并发ensure和原子发布。
4. Gateway握手失败保留上一个可运行Node版本。
5. application shutdown与异常退出回收Node Gateway及Provider descendants。
6. release evidence记录Node version、target、archive/executable hash和size。
