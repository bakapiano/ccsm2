# Session 模型与恢复

## 身份分层

```text
Space ID
├─ root folder
├─ Tab ID → Resource ID          # 完整布局中的视图引用
└─ CCSM Session ID               # 长期业务身份
   ├─ cwd / GitRepository ID?
   ├─ Native Session ID          # Claude/Codex/Copilot 身份
   └─ Runtime ID                 # 一次 PTY/进程树生命
```

这些 ID 各自独立。Space 通过 Tab 引用资源；一个 Session 可以经历多个runtime。用户关闭CLI Tab时删除Tab和Session，Space切换时只卸载视图。

## 核心字段

```text
CliSession {
  id, space_id, provider, cwd, git_repository_id?, launch_spec,
  native_session_id?, native_binding_state, desired_state,
  last_exit_summary?,
  created_at, last_active_at
}

TerminalRuntime {
  runtime_id, session_id, pid,
  cols, rows, actual_state, started_at, exited_at?
}
```

`CliSession`及其当前`native_session_id`写入`data.db`。`TerminalRuntime`由AppBackend的RuntimeManager保存在内存中。

`desired_state = running | stopped` 表示跨启动保留的用户意图。`actual_state = starting | live | exited | lost` 表示当前应用进程观察到的runtime事实。

`native_binding_state = not_applicable | pending | bound | unavailable`保存在CliSession。Shell使用`not_applicable`；Claude/Codex/Copilot创建时为`pending`，认证HookReport将其更新为`bound`。Runtime结束或应用重启时仍为`pending`的Session进入`unavailable`。

同一`runtime_id`的前端状态仅沿`starting → live → exited/lost`前进。Start command response和异步runtime event到达顺序可以交错；已经进入后续状态时忽略迟到的`starting`。

## 不变量

- 一个 CCSM Session 同时最多有一个 writable runtime。
- 一个 CliSession 同时最多有一个 non-deleted CLI Tab。
- RuntimeManager为每个CliSession维护一个runtime entry。ResumeKey优先使用`{provider, native_session_id}`，尚未绑定时使用`cli_session_id`；每个ResumeKey对应一个进程内mutex。
- 每次spawn创建新的opaque UUID `runtime_id`；RuntimeManager丢弃与当前runtime ID不匹配的Hook、PTY和exit event。
- 认证HookReport是native Session ID的唯一来源。
- 当前runtime确认新的native ID时更新同一CliSession字段；partial unique index拒绝绑定到其他未删除CliSession的ID。
- Stop停止runtime并保留Tab和Session；关闭CLI Tab停止runtime并删除Tab和Session。
- Space Switch保持当前应用内已存在的runtimes。
- Space Delete先停止其runtime并释放Tab resources，再删除Session和资源引用。

状态变化：

```text
Create/Resume  → desired_state=running
User Stop      → desired_state=stopped
Runtime spawn  → actual_state=starting
Hook/live I/O  → actual_state=live
Normal exit    → actual_state=exited
Unexpected exit → actual_state=lost
App crash      → 丢弃全部内存runtime；desired_state保持原值
```

## Resume 流程

```text
derive ResumeKey and acquire mutex
→ 等待目标 Tab 提供稳定 rows/cols
→ 创建 PTY + wrapper
→ claude --resume ID / codex resume ID
→ SessionStart Hook 确认 binding
→ register runtime entry
→ actual_state = live
```

runtime注册完成、超时或spawn失败后释放mutex。恢复策略：

- live runtime 存在时自动 attach。
- 当前打开Space中`desired_state=running`、runtime缺失且binding为`bound`的Agent CLI Session自动cold resume。
- Shell Session在runtime缺失时创建新runtime；`native_binding_state=unavailable`的Agent CLI Session进入degraded并等待Start New/Replace。
- 未打开 Space 在用户打开时执行相同恢复判断。
- `desired_state=stopped` 保持 stopped。
- cold resume 并发上限为 2；失败进入 degraded并等待显式 Retry。
