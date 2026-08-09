# CLI Session Tab

CLI Session Tab 通过稳定 `cli_session_id` 引用 Session，并在 mount 时 attach 当前 runtime。spawn/resume 通过 per-invocation Hook 绑定 provider native Session ID。

## Built-in Providers

| Provider    | Launch                  | Native Session    | Cold resume            |
| ----------- | ----------------------- | ----------------- | ---------------------- |
| Shell       | platform default shell  | —                 | 创建新 runtime         |
| Claude Code | 优先`ccp`，回落`claude` | Hook `session_id` | `claude --resume <id>` |
| Codex       | 优先`cxp`，回落`codex`  | Hook `session_id` | `codex resume <id>`    |

Provider resolver先遍历完整PATH寻找本地launcher，再遍历完整PATH寻找raw CLI。launcher内部再次调用同名CLI时，per-runtime shim通过depth guard只解析raw CLI，避免`ccp/cxp → shim → ccp/cxp`递归。用户自定义 command/args/env/resume template进入后续版本。

## Hook 注入

## 目标

Claude/Codex 自己上报 native Session ID。Hook 配置通过本次进程参数注入，用户的 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 保持原样。

## 启动链路

```text
per-runtime shim directory added to PATH
→ user/CCSM invokes claude or codex
→ ccsm wrapper resolves the real CLI outside shim directory
→ inject per-invocation Hook arguments
→ exec real CLI
→ Hook reads native payload from stdin
→ ccsm[.exe] hook report → HookEndpoint → AppBackend
```

wrapper 必须避免递归解析到自己。平台实现：

| 平台    | shim                        | real CLI 启动                                                       |
| ------- | --------------------------- | ------------------------------------------------------------------- |
| Windows | PATH 首位的同名 `.exe` shim | 排除 shim 目录后解析 `.exe/.cmd/.bat`，由 Windows launcher 保真传参 |
| macOS   | 可执行脚本或 symlink shim   | 排除 shim 目录后 `exec` real binary                                 |
| Linux   | 可执行脚本或 symlink shim   | 排除 shim 目录后 `exec` real binary                                 |

`CliShimAdapter` 管理 PATH 拆分、可执行文件后缀和 quoting。Hook JSON 和 Session binding 逻辑保持跨平台一致。

## 注入方式

Claude：

```text
claude --session-id <uuid> --settings '<merged-hook-json>' ...
claude --settings '<merged-hook-json>' --resume <id>
```

- 新会话可预分配 UUID，但 `SessionStart` payload 仍是最终权威。
- 用户传入的 `--settings` 与 CCSM settings 深度合并，最终只保留一个参数。
- 两个Provider注入`SessionStart`、`UserPromptSubmit`、`PermissionRequest`、`PreToolUse`、`Stop`和`SessionEnd`；Claude额外注入`StopFailure`。首次workspace trust发生在`SessionStart`之后时，第一条prompt仍可完成native binding。

Codex：

```text
codex --enable hooks --dangerously-bypass-hook-trust \
  -c 'hooks.SessionStart=...' \
  -c 'hooks.UserPromptSubmit=...' \
  ...
```

## 上下文与校验

每次 spawn 注入：

```text
CCSM_SESSION_ID
CCSM_RUNTIME_ID
CCSM_HOOK_PIPE
CCSM_HOOK_TOKEN
```

AppBackend校验token、provider、session、runtime ID和payload ID。Hook命令读取stdin、异步转发并立即返回。认证HookReport是Claude/Codex native Session ID的唯一来源；Shell跳过native binding。

## Agent activity

RuntimeManager维护进程内状态：

```text
SessionStart       → idle
UserPromptSubmit   → working，开启turn
PermissionRequest → blocked
PreToolUse         → working
Stop               → idle，关闭turn
StopFailure        → idle，关闭turn（Claude）
SessionEnd         → stopped
```

关闭turn后到达的`PreToolUse`和`PermissionRequest`保持当前状态，下一次`UserPromptSubmit`开启新turn。PTY exit始终发布`stopped`。activity通过`agent.activityChanged`进入DesktopEventStream，并由`list_agents` snapshot完成启动和重连恢复。activity、turn和runtime ID保持在内存中。

`CCSM_HOOK_TOKEN`按runtime随机生成，由RuntimeManager保存在内存中，通过子进程环境传递，并在runtime结束时失效。Token不写入`data.db`或logs。

Hook尚未到达时显示`binding pending`，CLI和PTY继续运行。Runtime结束仍未绑定时进入`resume unavailable`；下一次恢复显示degraded并提供Start New/Replace。CCSM不扫描provider配置、transcript或mtime执行身份猜测。

当前 Windows-first 项是 `.exe/.cmd` 解析与 quoting；macOS/Linux 在宣称支持前必须用真实 npm/native CLI 安装分别验证 shim、resume 和 Hook stdin。
