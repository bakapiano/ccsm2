# Remote Control

## Boundary

Agent Gateway为Remote Web提供Session级HTTPS REST与WebSocket。Remote Web控制已注册的CCSM Agent Sessions，并消费与Desktop一致的SessionSnapshot和sequenced events。

```text
Remote Web
  ⇅ HTTPS / WebSocket
Agent Gateway Remote transport
  ⇅ SessionController
Provider connections + Rust host channel
```

Gateway与Rust主进程共享应用生命周期。CCSM运行期间Remote Control可用。未来headless Gateway daemon使用相同Remote protocol、pairing records和SessionController contract。

## Listener

Gateway默认创建loopback listener并使用动态端口。Rust握手获得`remoteOrigin`并在Settings中展示状态。用户启用Remote Control后选择受控LAN interface或安全overlay network address。

公开interface配置包含：

```text
listen address
TLS certificate source
allowed origins
pairing enabled
rate limits
session visibility policy
```

TLS终止可由Gateway内置listener或受信本地reverse proxy完成。Gateway通过显式trusted-proxy设置接受forwarded client identity。

## API

REST负责snapshot与mutations：

```text
GET    /api/v1/sessions
GET    /api/v1/sessions/:id
POST   /api/v1/sessions/:id/open
POST   /api/v1/sessions/:id/turns
POST   /api/v1/sessions/:id/interrupt
PUT    /api/v1/sessions/:id/options/:optionId
POST   /api/v1/sessions/:id/approvals/:requestId
DELETE /api/v1/sessions/:id/connection
```

WebSocket负责有序事件与reconnect：

```text
session.snapshot
session.stateChanged
history.snapshot
message.start/delta/end
activity.update/delta
approval.request/resolved
config.updated
turn.completed
```

client连接时提交`lastSeq`。Gateway在replay buffer覆盖该位置时回放后续events；buffer缺口触发完整snapshot，再从snapshot seq继续增量。

## Pairing and identity

本地Settings生成短时pairing code或QR payload。成功配对签发device-scoped credential，并记录device ID、display name、capabilities、created/last-used time和revocation state。

Remote roles：

| Role | Capabilities |
| --- | --- |
| viewer | Session list、snapshot、history、events |
| controller | viewer + send、interrupt、普通approval |
| admin | controller + Model/Effort/Permission、full-access approval、device管理 |

Pairing code具有短TTL和单次使用语义。Device credential支持rotation与显式revocation。Gateway进程从Rust读取已提交pairing metadata；secret material从platform credential store或当前用户保护的secret store加载。

Remote requests携带device identity和request ID。审计记录device、Session、operation、decision和result，并对prompt、tool payload和credential执行redaction。

## Control lease and concurrency

每个SessionController串行执行turn与control mutations。`clientMessageId`为send提供幂等性；`requestId`为其他mutations提供重试关联。

一个Session同时拥有一个control lease holder。Desktop获得本地优先级；Remote controller通过显式Take Control获得租约。lease具有heartbeat、TTL和release操作，并在client disconnect后自动到期。

Approval request只能完成一次。第一个有效resolution成为结果；其他clients收到`approval.resolved`。Turn运行期间Gateway根据Provider capability接受interrupt和可并发读取的snapshot请求。

## Rust coordination

Remote domain mutations通过Gateway persistent host channel请求Rust授权：

```text
Remote request
→ authenticate device capability
→ request host authorization/current generation
→ Rust validate Session/runtime/lease and persist desired mutation
→ Gateway apply Provider operation
→ Rust commit/effective snapshot coordination
→ publish result and sequenced event
```

Rust继续拥有CCSM Session lifecycle、native binding、desired state与配置快照。Gateway拥有Remote connection和Provider operation。Provider失败返回结构化结果，Rust与Gateway通过operation ID协调最终effective state。

## Session visibility

默认Remote列表展示当前CCSM实例注册且policy允许的Agent Sessions。Space和Session可设置Remote visibility。Shell与raw Terminal字节流进入独立capability范围；首个结构化Remote版本聚焦Claude、Codex和GitHub Copilot Gateway runtimes。

Gateway通过Provider API读取已绑定Session history。外部native Session候选进入显式Import流程；认证Hook完成binding后成为可远程控制的CCSM Session。

## Security

- Listener使用明确address和TLS状态。
- Origin allowlist覆盖浏览器请求与WebSocket upgrade。
- Device credential通过Authorization header或安全WebSocket protocol传递。
- CSRF protection覆盖cookie-based辅助流程。
- 请求体、event payload和history page具有大小与速率限制。
- full-access permission与高风险approval要求admin capability和明确确认。
- Provider credential保留在本机CLI环境。
- Gateway API限定为Session operations；filesystem、process和arbitrary command使用Provider permission流程。
- Logs和Remote diagnostics隐藏token、API credential及敏感Provider payload。

## Data

`settings`保存：

```text
remote_control_enabled
remote_listen_mode
remote_allowed_origins
```

Rust独立durable table保存pairing device metadata和revocation records。Gateway通过host commands读取与提交。Token secret进入platform credential store或当前用户保护的secret store。

Gateway event replay、WebSocket connections、heartbeat、rate counters和control leases保持内存态。Gateway restart后clients重新认证并通过SessionSnapshot恢复。

## Failure handling

| Failure | Result |
| --- | --- |
| Remote断线 | lease进入TTL，client使用lastSeq重连 |
| replay gap | 返回完整snapshot与新base seq |
| Gateway restart | WebSocket断开，Rust恢复Gateway Sessions，client重新连接 |
| Rust host channel中断 | Gateway冻结remote mutations并保持受限status页面 |
| credential revoked | 当前及后续connections终止 |
| TLS/listen配置错误 | 保持loopback管理入口并报告configuration error |

## Acceptance

1. viewer、controller与admin capabilities覆盖允许及拒绝路径。
2. pairing code TTL、单次使用、rotation和revocation通过安全测试。
3. 两个Remote clients与Desktop竞争control lease时产生确定结果。
4. send重试、approval竞争、interrupt与Provider error保持幂等。
5. WebSocket断线、replay gap、Gateway restart和host resync恢复一致snapshot。
6. loopback、LAN与安全overlay配置覆盖origin、TLS和trusted proxy测试。
7. Claude、Codex和Copilot完成Remote new/resume、chat、tool、approval和config E2E。
