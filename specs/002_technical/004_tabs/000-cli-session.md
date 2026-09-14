# CLI Session Tab

CLI Session Tab 通过稳定 `cli_session_id` 引用 Session，并在 mount 时 attach 当前 runtime。spawn/resume 通过 per-invocation Hook 绑定 provider native Session ID。

Terminal renderer将产生CLI输入的键盘事件、paste和IME提交作为input-follow触发源，单独的修饰键保留scrollback viewport。顶层窗口失活时记录可见CLI的textarea焦点，窗口重新激活后恢复同一输入目标。Windows Alt+Tab将键盘焦点留在Tauri顶层容器时，宿主检测该空悬焦点并将其转交给main WebView，再由Terminal恢复textarea。

## Built-in Providers

| Provider       | Launch                 | Native Session    | Cold resume             |
| -------------- | ---------------------- | ----------------- | ----------------------- |
| Shell          | platform default shell | —                 | 创建新 runtime          |
| Claude Code    | `claude`               | Hook `session_id` | `claude --resume <id>`  |
| Codex          | `codex`                | Hook `session_id` | `codex resume <id>`     |
| GitHub Copilot | `copilot`              | Hook `session_id` | `copilot --resume=<id>` |

Provider resolver遍历完整PATH寻找对应的原生CLI。per-runtime shim通过depth guard把CLI内部的同名调用转发到已解析的原生CLI。用户自定义command、args、env和resume template进入后续版本。

每个新PTY runtime在注入本次Hook身份前清除继承的`CCSM_WRAPPER_ACTIVE`、native Session ID、Hook token/endpoint和plugin目录。用户从一个CCSM Agent终端启动另一份CCSM时，内层runtime仍执行自己的Hook与native resume注入；depth guard只约束当前provider进程树中的递归调用。

Windows resolver将进程继承的PATH与当前HKCU/HKLM环境PATH合并，并把合并结果传给launcher。Explorer在CLI安装前启动所持有的旧环境不能导致已安装Provider持续不可用；开发终端临时PATH保持最高优先级。

## Hook 注入

## 目标

Claude/Codex/Copilot 自己上报 native Session ID。Hook 配置通过本次进程参数注入，用户的 `~/.claude/settings.json`、`~/.codex/hooks.json`和`~/.copilot`保持原样。

## 启动链路

```text
per-runtime shim directory added to PATH
→ user/CCSM invokes claude or codex
→ ccsm wrapper resolves the real CLI outside shim directory
→ inject per-invocation Hook arguments
→ exec real CLI
→ Hook reads native payload from stdin
→ ccsm[.exe] hook report → RuntimeReportEndpoint → AppBackend
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
codex --enable hooks \
  -c 'hooks.SessionStart=...' \
  -c 'hooks.UserPromptSubmit=...' \
  ... \
  --dangerously-bypass-hook-trust
```

inline hook definitions必须位于`--dangerously-bypass-hook-trust`之前；Codex 0.144按CLI config加载顺序计算本次invocation trust，顺序反转会让`SessionStart`进入review pending并被跳过。

GitHub Copilot：

```text
copilot --plugin-dir <per-runtime-plugin>
copilot --plugin-dir <per-runtime-plugin> --resume=<id>
```

per-runtime plugin包含`plugin.json`和`hooks.json`，通过Copilot的VS Code兼容PascalCase事件注入`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`Stop`与`SessionEnd`。`notification`以`permission_prompt|elicitation_dialog` matcher报告真实用户阻塞状态。plugin的Windows PowerShell与POSIX bash字段保真引用per-runtime `ccsm-hook`绝对路径。plugin随runtime释放，不修改用户或repository hook配置。

Claude和Codex的Hook command由Provider原生命令shell直接执行reporter。Windows Claude使用双引号保真引用per-runtime `ccsm-hook.exe`绝对路径；Windows Codex使用中性`ccsm-hook hook report`并通过PATH首位的per-runtime shim解析`.exe`；POSIX使用相同中性命令解析无扩展名shim。三条链路都省去嵌套shell进程。

## 上下文与校验

每次 spawn 注入：

```text
CCSM_SESSION_ID
CCSM_RUNTIME_ID
CCSM_HOOK_PIPE
CCSM_HOOK_TOKEN
```

RuntimeReportEndpoint读取tagged envelope并按producer/kind写入高优先级Hook队列、普通Gateway status队列或受限activity队列。独立消费者调用AppBackend完成token scope、provider、session、runtime ID、generation、seq和payload ID校验，再通过platform resolver解析Provider Session metadata并提交状态更新。Hook命令完成endpoint写入后立即返回空JSON响应。认证HookReport是Claude/Codex/Copilot native Session ID的唯一来源；Shell跳过native binding。

Hook reporter从`session_title/sessionTitle`生成标题候选。消费者对认证Hook给出的Claude/Codex精确`transcript_path`执行有界JSONL读取，提取显式标题和Provider摘要；Codex同时按native Session ID读取相邻`session_index.jsonl`中的thread name。标题归一化后最多保存96个字符。缺少原生标题时，Agents使用Tab标题。用户prompt仅更新session activity和last-active时间。`cli_sessions.display_title`保存最近确认的原生标题，`last_active_at`以Unix毫秒记录每次有效Hook或runtime生命周期活动。

Hook reporter同时归一化provider的会话谱系字段：Codex使用`forked_from_id/forkedFromId + ephemeral`，Claude使用`parent_session_id/parentSessionId + is_sidechain/isSidechain`，Copilot接受相同snake_case/camelCase组合。带父身份的ephemeral Hook更新runtime activity，并让`CliSession.native_session_id`保持当前可恢复父会话。

Codex `/btw`的当前Hook payload通过新的`session_id`和空`transcript_path`表达内存side session。已有父绑定、新ID、空transcript且来源属于临时startup的报告使用相同ephemeral绑定规则。`source=clear|resume|fork`和带transcript的持久会话报告更新native binding，因此`/clear`、resume和持久fork继续成为可恢复目标。

## Agent activity

RuntimeManager维护进程内状态：

```text
Codex runtime spawn → idle（native binding可以保持pending）
SessionStart       → idle
UserPromptSubmit   → working，开启turn
PermissionRequest → blocked
Copilot permission/elicitation notification → blocked
PreToolUse         → working
Stop               → idle，关闭turn
StopFailure        → idle，关闭turn（Claude）
SessionEnd         → 保持当前activity、turn、binding和last-active状态
```

关闭turn后到达的`PreToolUse`和`PermissionRequest`保持当前状态，下一次`UserPromptSubmit`开启新turn。PTY exit始终发布`stopped`。有效Hook更新`last_active_at`并发布包含当前activity、display title和活跃时间的`agent.activityChanged`；同状态事件同样发布。`list_agents` snapshot完成启动和重连恢复。activity、turn和runtime ID保持在内存中。

Codex与Copilot TUI在空提示符阶段尚未创建native session，首次prompt前不会发送`SessionStart`。因此两者成功spawn后仅将activity置为`idle`；native Session ID仍只接受后续认证HookReport。Claude由启动期`SessionStart`完成`starting → idle`。

`CCSM_HOOK_TOKEN`按runtime随机生成，由RuntimeManager保存在内存中，通过子进程环境传递，并在runtime结束时失效。Token不写入`data.db`或logs。

Hook尚未到达时显示`binding pending`，CLI和PTY继续运行。Runtime结束仍未绑定时进入`resume unavailable`；下一次恢复显示degraded并提供Start New/Replace。CCSM使用认证Hook完成身份绑定；Session metadata读取目标限定为该Hook给出的精确路径和native Session ID。

当前 Windows-first 项是 `.exe/.cmd` 解析与 quoting；macOS/Linux 在宣称支持前必须用真实 npm/native CLI 安装分别验证 shim、resume 和 Hook stdin。

结构化Agent Gateway runtime继续使用同一CLI shim与Hook binding。Gateway对原生协议事件的观察通过RuntimeReportEndpoint补充turn、tool、approval和transport状态，详细协议见[Runtime reports](../002_runtime/005-runtime-reports.md)。
