# Runtime reports

## Purpose

`RuntimeReportEndpoint`是Rust AppBackend接收外部runtime事实与Gateway control traffic的统一当前用户IPC入口。现有HookEndpoint演进为该endpoint。

```text
Hook reporter ── one-shot report ──┐
Board MCP     ── one-shot report ──┼→ RuntimeReportEndpoint → AppBackend
Agent Gateway ⇄ persistent RPC ────┘
```

Windows使用当前用户Named Pipe。macOS/Linux使用当前用户权限Unix socket。endpoint address由desktop composition root创建，并通过每次runtime的受控environment传给外部进程。

## Framing and envelope

所有connections使用相同length-delimited JSON framing。每个frame限制为1 MiB；activity output使用有界chunks。协议版本不匹配返回结构化error并关闭对应connection。

```json
{
  "version": 2,
  "kind": "gateway.status",
  "producer": "agent-gateway",
  "runtimeId": "runtime-123",
  "generation": 2,
  "seq": 18,
  "token": "runtime-capability",
  "payload": {
    "transportState": "connected",
    "turnState": "waiting_approval"
  }
}
```

Report kinds：

```text
hook.event
gateway.status
gateway.snapshot
gateway.rpc
board.changed
```

`gateway.rpc`在persistent Gateway connection上承载Rust发起的commands、Gateway responses和Gateway发起的host requests。`requestId`关联request/response；status reports使用`runtimeId + generation + seq`排序。

## Producers and authentication

| Producer | Connection | Credential | Scope |
| --- | --- | --- | --- |
| Hook reporter | one report per connection | per-runtime Hook token | Hook event与native binding |
| Agent Gateway | persistent bidirectional | application Gateway token | host RPC与registered runtime reports |
| Gateway Session | multiplexed on Gateway connection | per-runtime capability | 一个CLI Session/runtime observation |
| Board MCP | one report per connection | per-runtime token | 一个Space/Session的Board change |

Gateway完成application token握手后才能发送RPC与注册Session channels。Rust在`session.open`时签发runtime capability，并绑定`cliSessionId`、provider、runtime ID和generation。runtime结束立即撤销该capability。

Endpoint验证：

```text
version
producer kind
token scope
provider
cliSessionId
runtimeId
generation
monotonic seq
payload size
```

文件名、PID和remote client字段用于诊断与审计。credential与runtime identity形成授权依据。

认证HookReport是native Session ID的唯一持久来源。Gateway的`session.boundObserved`作为关联hint；Rust提交对应Hook binding后通过`binding.confirmed`返回canonical identity。

## Dispatch

Endpoint完成轻量framing与authentication后按类型分流：

```text
high priority bounded queue
  hook.event / binding / process exit

normal bounded queue
  gateway.status / snapshot / approval / turn lifecycle

bulk bounded queue
  activity delta / tool progress / diagnostic tail
```

Hook reporter在high priority enqueue成功后收到空success response。Gateway收到queue pressure error后保留最新完整snapshot，并按Rust提供的resync request重新发送。bulk队列按activity ID合并连续progress，保持状态终点事件。

独立消费者调用AppBackend reducer。单个慢速metadata解析任务进入blocking pool；endpoint accept loop与其他runtime reports保持可用。

## State merge

Rust reducer接收三类输入：

```text
process supervisor → processState
authenticated Hook → bindingState + provider semantic checkpoint
Gateway report     → transportState + turnState + tool/approval observation
```

接受规则：

1. report匹配RuntimeManager当前`runtimeId + generation`。
2. Gateway Session `seq`严格递增；重复frame保持幂等。
3. process exit确定runtime的`exited/lost`状态。
4. Hook确定native binding以及clear/resume/fork身份变化。
5. Gateway snapshot覆盖该generation已知的Gateway observation集合。
6. Gateway delta从snapshot seq继续应用。

Gateway每5秒发送heartbeat。15秒无heartbeat使transport进入`degraded`并触发snapshot probe。persistent connection关闭使其全部runtime observations进入degraded；process supervisor继续提供进程事实。

## Compatibility

Endpoint在迁移期识别已发布的legacy HookReport与BoardChangeReport shape，并归一化到v2 envelope。Gateway从v2开始使用tagged envelope。compatibility parser在所有已支持runtime升级完成后进入后续schema cleanup。

## Failure handling

| Failure | Result |
| --- | --- |
| malformed frame | 返回invalid report并记录受限diagnostic |
| token或scope错误 | 拒绝frame并记录security event |
| stale runtime/generation | 丢弃frame并返回stale runtime |
| seq gap | 请求Gateway snapshot resync |
| queue pressure | 保留高优先级事件并合并bulk progress |
| Gateway disconnect | transport degraded，等待restart/snapshot |

Logs对token、credential、prompt和Provider raw payload执行redaction。

## Acceptance

1. Legacy Hook/Board和v2 tagged reports通过同一endpoint完成兼容解析。
2. Hook、Gateway和Board credential仅能提交其scope允许的report kinds。
3. 乱序、重复、seq gap、runtime replacement和Gateway reconnect生成确定SessionSnapshot。
4. 高bulk压力下Hook/native binding与process exit保持有界延迟。
5. Gateway restart完成application握手、runtime re-registration与snapshot resync。
6. Windows Named Pipe与macOS/Linux Unix socket共享framing和contract fixtures。
