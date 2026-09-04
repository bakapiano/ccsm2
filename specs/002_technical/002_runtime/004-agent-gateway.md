# Agent Gateway 与 Remote Control

## 定位

`Agent Gateway`是由Rust AppBackend监管的常驻TypeScript子进程，提供两个能力：

1. 通过Claude Agent SDK、Codex App Server和GitHub Copilot ACP观察原生Session，并将实时状态标准化后上报Rust。
2. 为配对后的Remote Web提供Session查看、对话、审批、配置和中断接口。

Gateway管理活动Provider connection及其事件流。Rust AppBackend管理CCSM Session、native binding、配置快照、runtime identity和持久化。Provider CLI管理原生transcript与上下文。

```text
Claude / Codex / GitHub Copilot
              ⇅ native protocol
       TypeScript Agent Gateway
          ⇙                 ⇘
RuntimeReportEndpoint      HTTPS / WebSocket
        ⇅                       ⇅
 Rust AppBackend             Remote Web
```

Gateway属于应用作用域。Rust进程运行期间Gateway可用；主进程shutdown统一结束Gateway及其Provider进程树。未来用户级daemon可复用相同协议并形成独立composition root。

## Source tree

```text
apps/agent-gateway/
├─ src/
│  ├─ core/session-controller.ts
│  ├─ core/event-log.ts
│  ├─ providers/claude.ts
│  ├─ providers/codex.ts
│  ├─ providers/copilot.ts
│  ├─ transports/host-ipc.ts
│  └─ transports/remote-http.ts
├─ remote-web/
└─ dist/
   ├─ agent-gateway.mjs
   └─ web/

crates/ccsm-core/
└─ AgentGatewayBackend port、DTO和状态reducer

crates/ccsm-platform/
├─ NodeRuntimeManager
├─ NodeAgentGateway adapter
└─ RuntimeReportEndpoint
```

生产构建将Gateway及其runtime dependencies打包为单一ES module bundle。Remote Web构建为静态assets。Tauri resource目录携带bundle与assets，platform adapter通过绝对resource path启动。

## Ownership

| State | Owner |
| --- | --- |
| CCSM Session、Space、desired state | Rust AppBackend |
| native Session ID与binding state | Rust AppBackend，经认证HookReport确认 |
| Model、Effort、Permission配置快照 | Rust StateStore |
| Gateway process、runtime ID、resume mutex | Rust RuntimeManager |
| active connection、turn、tool、approval、transport | Agent Gateway |
| Provider transcript、历史和上下文 | Provider CLI |
| Remote pairing、client identity和控制lease | Agent Gateway |

Rust `data.db`保持单一writer。Gateway状态位于内存；Gateway重启后由Rust提供已提交的Session metadata与配置快照，并通过Provider native resume恢复活动connection。

## Process model

AppBackend惰性创建一个Gateway进程，所有结构化Agent Sessions复用该进程内的独立logical connections。

```text
ccsm-desktop
└─ node agent-gateway.mjs
   ├─ codex app-server
   ├─ copilot --acp --stdio
   └─ claude Agent SDK child process
```

启动流程：

```text
resolve Node runtime
→ resolve Gateway bundle与Remote Web绝对路径
→ start RuntimeReportEndpoint
→ generate application-scoped Gateway token
→ spawn Node child inside process containment
→ connect persistent Gateway channel to RuntimeReportEndpoint
→ validate hello/protocol versions
→ publish gateway.ready
```

Gateway启动握手包含：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "gatewayVersion": "0.1.0",
  "nodeVersion": "24.11.0",
  "pid": 12345,
  "remoteOrigin": "http://127.0.0.1:43921"
}
```

Gateway process使用Windows隐藏窗口标志。Windows Job Object和Unix process group/watchdog覆盖Gateway与其Provider descendants。stdout/stderr由Rust持续消费并写入CCSM logs；RuntimeReportEndpoint承载Gateway host channel。

正常shutdown先发送`gateway.shutdown`并等待最多3秒，随后process containment完成剩余进程树回收。Gateway意外退出产生`gateway.lost`，当前Gateway runtimes进入`lost/degraded`，下一次用户操作或恢复调度创建新Gateway实例。

## Node runtime dependency

`NodeRuntimeManager`解析Node 22+系统runtime，并提供固定Node 24 LTS的managed fallback。Gateway bundle、Node executable、Remote Web assets和Provider CLI paths均以绝对路径启动。下载、校验、原子安装和更新协议见[Managed Node runtime](006-managed-node-runtime.md)。

## Host control protocol

Rust与Gateway在RuntimeReportEndpoint上使用长连接、双向、版本化JSON-RPC。该Gateway connection与Hook/Board短连接共享同一个listener和framing。每个请求携带`requestId`；每个Session command携带`cliSessionId`和当前`runtimeId/generation`。

核心方法：

```text
gateway.hello
gateway.shutdown
session.open          mode=new|resume
session.close
session.snapshot
turn.send
turn.interrupt
option.set
approval.resolve
binding.confirmed
```

核心事件：

```text
gateway.ready
gateway.lost
session.boundObserved
session.stateChanged
history.snapshot
message.start/delta/end
activity.update/delta
approval.request/resolved
config.updated
turn.completed
```

`clientMessageId`为`turn.send`提供幂等性。Gateway按connection串行执行turn和control mutations。Rust持久化配置成功后将committed snapshot传给Gateway；Gateway应用后返回effective provider options。

## Runtime reports

现有HookEndpoint演进为`RuntimeReportEndpoint`。Hook、Gateway和Board MCP共享当前用户作用域的listener与framing；Gateway persistent host channel同时承载双向control和状态上报。认证、队列、envelope及resync协议见[Runtime reports](005-runtime-reports.md)。

## Session state

状态采用正交维度：

```text
bindingState    not_applicable | pending | bound | unavailable
processState    starting | live | exited | lost
transportState  connecting | connected | degraded | closed
turnState       idle | working | waiting_approval | interrupting
```

Rust reducer接收process lifecycle、HookReport和Gateway observation，生成对Desktop与Remote一致的`SessionSnapshot`。`AgentActivity`由上述维度推导。

合并规则：

1. `runtimeId + generation`匹配当前runtime后接受report。
2. 每个Gateway connection的`seq`单调递增；重复及迟到report保持幂等。
3. process exit确定当前runtime的`exited/lost`。
4. HookReport确定native binding和Provider语义节点。
5. Gateway observation更新transport、turn、tool和approval状态。
6. Gateway重连先发送完整snapshot，再从snapshot seq继续增量。
7. Gateway heartbeat每5秒发送；15秒无heartbeat使transport进入`degraded`。

活动状态保存在Rust内存。`data.db`保存binding、desired state、配置和最后退出摘要。

## Terminal and Gateway runtimes

同一CCSM Session同时拥有一个writable runtime。Terminal与Gateway使用相同ResumeKey和mutex。

```text
Terminal active
→ stop PTY runtime
→ acquire ResumeKey
→ Gateway resume native Session
→ Gateway runtime active
```

Gateway切回Terminal时执行对称流程。每次engine切换产生新的opaque `runtimeId`；旧runtime的Hook、report和exit事件由runtime identity过滤。

Gateway只为自己启动的Provider connections提供原生协议级实时状态。PTY Terminal继续通过Hook与process supervisor上报。Rust reducer向两种runtime提供统一SessionSnapshot。

Provider启动继续经过CCSM CLI shim并注入Hook、Board MCP和runtime context：

- Claude SDK使用CCSM Claude shim作为`pathToClaudeCodeExecutable`，new/resume由SDK参数表达。
- Codex shim启动`codex app-server`，Gateway通过`thread/start|resume`选择native thread。
- Copilot shim启动ACP模式，Gateway通过`session/new|load`选择native Session；ACP模式由shim跳过CLI级`--resume`注入。

## Remote Control

Gateway为配对Remote Web提供HTTPS REST、WebSocket、静态assets和sequenced event replay。Remote commands进入与Rust本地命令相同的SessionController。API、pairing、capabilities、control lease和网络安全协议见[Remote Control](007-remote-control.md)。

## Failure and recovery

| Failure | Recovery |
| --- | --- |
| Gateway启动/握手失败 | 回收进程树并发布diagnostic |
| Gateway意外退出 | runtime进入lost/degraded，supervisor重建Gateway |
| Provider process退出 | Gateway完成turn并上报provider exit |
| host IPC中断 | Gateway停止接受remote mutations并等待host恢复或shutdown |

Runtime report、Gateway stderr、Provider stderr tail和Remote security events进入CCSM logs。日志对token、credential、prompt敏感字段和Provider raw payload执行redaction。

## Data impact

`cli_sessions`增加Gateway所需的配置快照和preferred runtime engine：

```text
preferred_engine = terminal | gateway
model?
effort?
permission_profile
```

Schema migration采用新增nullable/default columns和table，保持已发布数据语义。

## Acceptance

1. Gateway与Provider descendants在正常退出、异常退出和updater handoff中完成进程清理。
2. Claude、Codex、Copilot完成new、chat、tool、approval、config、close和native resume E2E。
3. 同一native Session的Terminal/Gateway并发启动由ResumeKey拒绝，engine切换完成cold resume。
4. Gateway crash后Rust发布lost/degraded状态，并通过新Gateway实例恢复已提交Sessions。
5. CI固定Node、Provider CLI和Gateway bundle版本，并记录version、hash、事件与进程清理证据。
