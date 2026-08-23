# Remote Agent Host

状态：独立后续产品的锁定技术方向。当前Tauri v2本地桌面交付保持既有进程内AppBackend链路。

`ccsm-agent-host`把PTY、Provider进程树、HookEndpoint和远程Session registry部署到目标主机。CCSM Desktop和Web frontend通过版本化HTTPS/WSS协议连接同一远程运行时。

## 目标拓扑

```text
CCSM Desktop
└─ ccsm-remote-client
   └─ HTTPS/WSS ─┐
                 │
Browser frontend ├─ tunnel / reverse proxy / direct TLS
└─ HTTPS/WSS ────┘
                 │
ccsm-agent-host
├─ authentication + workspace policy
├─ remote Session registry
├─ PTY/process-tree adapters
├─ bounded output replay
├─ HookEndpoint + Agent events
└─ Shell / Claude / Codex / Copilot
```

Microsoft Dev Tunnels、Tailscale和普通反向代理提供可选的网络可达性与TLS入口。`ccsm-agent-host`提供应用级身份、Session授权和运行时所有权。

## Composition roots与crate边界

- `ccsm-core`定义远程Host、Session、attachment、activity和terminal transport DTO/ports。
- `ccsm-platform`继续实现本机PTY、process tree、Hook、filesystem和provider shim adapters。
- `ccsm-agent-host`是独立headless composition root，组合core/platform并实现HTTP、WebSocket、认证和远程Session registry。
- `ccsm-remote-client`实现Desktop使用的HTTPS/WSS client adapter，并把remote events映射为core events和binary terminal chunks。
- `ccsm-desktop`构造remote client并继续通过`CcsmDesktopClient`服务TypeScript renderer。
- `ccsm-web-server`可以把Web frontend静态资产与agent-host gateway部署到同一HTTPS origin。

Desktop、core和platform crates保持各自已有的Tauri/WebView边界。HTTP listener、WebSocket server和浏览器认证属于独立远程composition roots。

## 身份模型

```text
CCSM CLI Session ID           # 产品业务身份
├─ RemoteHost ID              # 用户保存的远程目标
├─ Remote Session ID          # agent-host持久Session
├─ Native Session ID          # Provider恢复身份
└─ Runtime ID                 # 一次Provider进程树生命
   └─ Attachment ID           # 一次WSS连接
```

`runtime_id`继续标识一次Provider进程树。网络重连创建新的`attachment_id`并保持当前`runtime_id`。Provider重启创建新的`runtime_id`并保持`remote_session_id`。

`data.db`为远程CLI Session保存`remote_host_id`和`remote_session_id`。Host URL、显示名、server fingerprint和capability snapshot属于durable host metadata。Bearer token、Tunnel token和WebSocket handle进入系统credential store或内存。

agent-host保存Session registry、允许的workspace roots、provider、cwd、desired state和当前runtime metadata。PTY handles、PID、controller lease、Hook token和连接序号保持host内存态。

## HTTP surface

```text
GET  /healthz
GET  /readyz
GET  /v1/capabilities
POST /v1/auth/exchange
POST /v1/sessions
GET  /v1/sessions/{session_id}
POST /v1/sessions/{session_id}/tickets
POST /v1/sessions/{session_id}/interrupt
POST /v1/sessions/{session_id}/stop
POST /v1/sessions/{session_id}/terminate
WS   /v1/terminal/{session_id}
WS   /v1/events
```

`POST /v1/sessions`接受`provider + workspace_id + initial rows/cols + persistence policy`。agent-host通过server-owned workspace mapping解析cwd和权限，返回`remote_session_id`及terminal attachment metadata。

`interrupt`执行Provider语义的当前工作中断并保持runtime。`stop`结束runtime并保留remote Session。`terminate`执行process-tree/tmux session清理并提交最终退出状态。

## Authentication与浏览器接入

Desktop remote client使用`Authorization: Bearer <agent-host-token>`。私有Microsoft Dev Tunnel连接可以同时携带`X-Tunnel-Authorization: tunnel <token>`。Desktop将长期secret保存到操作系统credential store。

同源Web部署执行以下流程：

```text
HTTPS login/exchange
→ Secure + HttpOnly + SameSite cookie
→ create/read Session
→ request 30-second single-use attachment ticket
→ browser opens WSS with cookie + ticket
```

Attachment ticket绑定`user_id + remote_session_id + mode(control|observe) + expiry + nonce`。agent-host原子消费nonce并拒绝重放。浏览器WebSocket的`Origin`必须匹配Host allowlist。

跨origin Web部署使用精确CORS origin、credentialed HTTPS和相同的单次Ticket流程。Web frontend通过标准`WebSocket` API连接，长期secret停留在HttpOnly cookie或gateway服务端。

## Terminal WebSocket protocol

子协议名为`ccsm-terminal-v1`。文本帧承载控制消息，二进制帧承载PTY bytes和sequence ACK。

连接后的第一条消息：

```json
{
  "type": "attach",
  "protocolVersion": 1,
  "clientId": "opaque-client-id",
  "mode": "control",
  "cols": 120,
  "rows": 30,
  "streamGeneration": 7,
  "lastSequence": 1024
}
```

agent-host响应：

```json
{
  "type": "attached",
  "sessionId": "remote-session-id",
  "runtimeId": "runtime-id",
  "attachmentId": "attachment-id",
  "controller": true,
  "streamGeneration": 7,
  "nextSequence": 1280,
  "processState": "live"
}
```

控制消息：

```text
resize(cols, rows)
signal(interrupt)
requestControl
releaseControl
ack(streamGeneration, sequence)
detach
```

二进制帧使用固定header：

```text
INPUT  = kind(1) + payload
OUTPUT = kind(1) + stream_generation(u32) + sequence(u64) + payload
ACK    = kind(1) + stream_generation(u32) + sequence(u64)
```

整数采用network byte order。文本帧和二进制帧共享同一个有序WebSocket连接。

## ghostty-web与Desktop接入

TypeScript Terminal Provider依赖transport-independent接口：

```ts
interface TerminalTransport {
  attach(request: TerminalAttachRequest): Promise<TerminalAttachment>;
  write(runtimeId: string, data: Uint8Array): Promise<void>;
  resize(runtimeId: string, cols: number, rows: number): Promise<void>;
  interrupt(runtimeId: string): Promise<void>;
  detach(runtimeId: string): Promise<void>;
  acknowledge(runtimeId: string, generation: number, sequence: bigint): void;
}
```

本地Tauri Channel和远程WSS实现同一byte/resize/ack contract。ghostty-web继续拥有VT、Canvas、IME、selection、mouse mode和当前renderer scrollback。

Desktop Rust remote client持有TLS、双层Tunnel/Host鉴权、WebSocket重连和binary framing。TypeScript通过`CcsmDesktopClient`接收有界binary chunks并复用现有input writer、resize scheduler和output credit逻辑。

## PTY与持久运行

agent-host使用portable-pty创建Provider PTY并管理read/write/resize。共享baseline由agent-host持有PTY和process tree：

```text
create remote Session
→ resolve server-owned workspace
→ create PTY + process guard
→ inject provider shim and authenticated Hook context
→ register runtime
→ accept control/observe attachments
```

macOS/Linux可以启用tmux persistence adapter。agent-host构造原始tmux命令和session名称，并向客户端暴露`remote_session_id`。Windows使用agent-host进程、ConPTY和Job Object持续持有runtime。

一个remote Session同时拥有一个controller attachment。Observer attachments接收相同OUTPUT和lifecycle events。Controller释放、断线或租约超时后，agent-host按FIFO授予已等待的控制请求。

## Output flow与重连

每个Session维护16 MiB replay ring和512 KiB per-controller unacknowledged byte上限。Host全局replay budget为256 MiB，并优先回收已停止且最近未attach的Session buffer。

```text
output bytes
→ assign stream generation + sequence
→ append bounded replay ring
→ send controller/observers
→ controller ACK releases byte credit
```

同一agent-host进程内的网络重连携带`streamGeneration + lastSequence`。ring仍覆盖该sequence时按序回放。覆盖缺口返回`resyncRequired`并附带当前screen snapshot metadata。新的agent-host进程或runtime创建新的stream generation。

Desktop renderer重载和应用冷启动创建新的ghostty VT。冷attach请求完整terminal snapshot或当前replay window，再开始增量OUTPUT。Renderer内的短暂网络重连使用sequence续传并保留现有VT。

WebSocket heartbeat使用20秒ping和60秒dead-peer timeout。重连采用带jitter的指数退避，并以30秒为单次恢复上限。

## Hook与Agent activity

HookEndpoint与Provider进程位于同一agent-host。每次runtime生成新的Hook token，并通过host-local Named Pipe或Unix socket接收报告。认证HookReport继续作为Claude/Codex/Copilot native Session ID的来源。

agent-host将`agent.activityChanged`、binding、runtime exit和transport health映射为版本化remote events。Desktop/Web reducer按`remote_session_id + runtime_id`过滤迟到事件。PTY exit始终发布`stopped`。

## 安全边界

- agent-host默认绑定loopback；公开入口由显式tunnel或TLS reverse proxy提供。
- TLS入口最低使用TLS 1.2，并优先TLS 1.3。
- Host allowlist精确验证Browser Origin、WebSocket subprotocol和HTTP CORS origin。
- Session创建使用server-owned`workspace_id → canonical root`映射和built-in Provider枚举。
- Provider argv、tmux名称、Hook command和cwd由host adapter构造。
- Controller lease、session mutation和process signal要求control scope。
- Ticket、Bearer token、Hook token和provider credential经过日志redaction。
- HTTP body、WebSocket frame、input burst、Session数量和replay memory使用有界限制。
- 审计日志记录身份、Session mutation、控制权变化、interrupt/stop/terminate和认证失败。

## Shutdown与异常恢复

```text
freeze new Session/attachment requests
→ revoke controller leases
→ close WebSocket listeners
→ stop managed runtimes according to desired state
→ join PTY readers/waiters
→ close HookEndpoint
→ checkpoint host registry
→ close process guards
```

managed runtime跟随agent-host process guard完成异常清理。tmux-backed runtime由host registry重新发现，并在agent-host恢复后等待新的attachment。显式Terminate清理两种persistence mode的完整process tree。

Desktop断线保持remote Session的desired state。用户重新打开Tab时，remote client先读取Session snapshot，再执行attach或受控resume。

## 交付阶段与验收

交付依次完成headless agent-host、Desktop remote adapter、Browser frontend、Provider完整性、persistence与tunnel。每个阶段保持上一阶段的协议兼容和cleanup contract。

验收场景覆盖：

- Desktop和浏览器分别创建、attach和控制同一remote Session；controller/observer切换保持input单写者和output同序。
- CJK、IME、paste、mouse mode、链接和连续resize保持本地Terminal contract。
- 断网后runtime继续运行，重连按sequence回放并恢复当前屏幕。
- Ticket重放、Origin偏差、越界workspace和无control scope mutation被拒绝。
- interrupt保持Session可继续输入；stop和terminate提交各自desired/actual state。
- agent-host、Tunnel、Desktop分别异常退出时产生可重复的cleanup与恢复结果；Windows、macOS和Linux使用各自PTY/process adapter通过相同协议测试。
