# Renderer 健康监控与恢复

CCSM桌面版由Rust主进程监督可信主WebView renderer。监控协议区分Rust进程、JavaScript事件循环和pointer交互状态，并在恢复前保存可诊断现场。

## Ownership

```text
ccsm-desktop (Rust)
├─ RendererHealthMonitor
├─ main WebView probe sender
├─ native recovery notification
├─ diagnostic journal writer
└─ reload/restart coordinator

main WebView (TypeScript)
├─ health probe responder
├─ pointer/input journal
├─ transient interaction snapshot
└─ dirty editor/runtime risk summary
```

`RendererHealthMonitor`属于`ccsm-desktop` composition root。`ccsm-core`和`ccsm-platform`不依赖WebView、窗口或renderer健康类型。

外部guardian属于未来的desktop host companion。它监督整个Rust进程；主进程内的`RendererHealthMonitor`监督JavaScript renderer。

## Health dimensions

健康状态由三个维度组成：

| 维度 | 证明方式 | 典型故障 |
| --- | --- | --- |
| Rust process | background task持续运行 | process crash、native deadlock |
| Renderer event loop | Rust probe收到匹配nonce的JS ACK | long task、infinite loop、renderer hang |
| Input path | ACK携带pointer和transient state | stale capture、drag、resize、透明overlay |

窗口仍可拖动和CSS动画仍在播放不构成renderer健康证明。Tauri drag region由native host处理，compositor animation可在JavaScript主线程阻塞时继续运行。

## Active probe protocol

Rust使用主动probe，避免依赖可能受background timer throttling影响的JavaScript `setInterval`。

```text
Rust watchdog tick
→ emit renderer.healthProbe { nonce, sentAt }
→ JavaScript listener在主事件循环执行
→ collect renderer snapshot
→ invoke renderer_health_ack(snapshot)
→ Rust核对nonce并更新last_ack_at
```

Probe默认每2秒发送一次。任一时刻只有一个待确认nonce；新的probe替换已过期的待确认记录。

```ts
interface RendererHealthAck {
  nonce: number;
  receivedAtMs: number;
  documentVisible: boolean;
  windowFocused: boolean;
  lastPointerDownAtMs: number | null;
  lastPointerUpAtMs: number | null;
  lastClickAtMs: number | null;
  capturedPointerCount: number;
  dockDragging: boolean;
  sidebarResizing: boolean;
  agentsResizing: boolean;
  modalKind: "app" | "directory" | null;
  dirtyEditorCount: number;
  liveShellRuntimeCount: number;
}
```

ACK仅包含健康元数据。终端内容、Agent prompt、文件内容、URL、剪贴板和credential不进入健康日志。

Rust使用monotonic `Instant`计算超时。系统时间调整不改变健康状态。

## Window lifecycle gating

主窗口处于visible且非minimized状态时执行renderer超时判定。以下转换进入宽限期：

- 应用启动或main WebView创建。
- renderer reload完成。
- Windows lock/sleep后的系统恢复。
- 窗口从minimized恢复。
- debugger暂停结束。

宽限期默认为10秒。窗口后台或最小化期间继续记录probe结果，但不触发自动恢复。

## Monitor state machine

```text
Starting
  └─ matching ACK → Healthy

Healthy
  └─ ACK age ≥ 5s → Suspect

Suspect
  ├─ matching ACK → Healthy
  └─ ACK age ≥ 10s → RendererUnresponsive

RendererUnresponsive
  ├─ diagnostic capture
  ├─ native recovery affordance
  └─ reload requested → Recovering

Recovering
  ├─ new renderer ACK within 15s → Healthy
  └─ timeout → RecoveryFailed
```

连续ACK重置miss counter。单次迟到ACK不覆盖更新nonce的状态。

## Pointer and transient interaction journal

TypeScript在window capture phase记录最近256条交互元数据：

```text
pointerdown / pointerup / pointercancel
click
gotpointercapture / lostpointercapture
Dock drag begin / finish
sidebar or Agents resize begin / finish
modal open / close
window blur / focus
```

每条记录保存event type、monotonic timestamp、pointer ID、button、target class摘要和相关状态位。target文本和业务payload不记录。

以下状态进入stale input诊断：

- `pointerdown`超过5秒没有对应`pointerup`或`pointercancel`。
- pointer capture超过5秒且buttons已经为0。
- Dock drag在window blur后仍为active。
- sidebar/Agents resize在pointer结束后仍为active。
- modal backdrop存在但没有对应dialog或pending request。

Renderer ACK正常且存在stale input时，状态标记为`InputPathSuspect`。该状态独立于renderer event-loop健康。

## Diagnostic capture

进入`Suspect`时Rust开始轻量采样；进入`RendererUnresponsive`时落盘完整诊断。

```text
logs/renderer-health/
└─ <timestamp>-<incident-id>.json
```

诊断包含：

- CCSM version、commit、Debug/Release和平台。
- main window visible/focused/minimized状态。
- 最近probe nonce、ACK age和状态转换时间线。
- 最近一次RendererHealthAck。
- pointer/transient ring buffer。
- Rust process和WebView2 process的PID、CPU与working set。
- active Space/Tab ID和Tab kind；不包含显示名称或内容。
- 最近100条结构化desktop event名称和correlation ID。
- recovery尝试次数与结果。

诊断写入使用独立blocking task。日志失败不阻止后续恢复动作。

## Recovery policy

首版提供native托盘项或原生快捷键`Reload UI`。该入口由Rust拥有，因此renderer无响应时仍可使用。

Soft reload顺序：

```text
freeze new renderer mutations
→ capture diagnostic
→ close transient main-WebView UI state
→ reload main WebView
→ subscribe and buffer desktop events
→ bootstrap committed snapshot
→ replay buffered events
→ wait for matching health ACK
```

AppBackend、PTY process trees、HookEndpoint和`data.db`保持存活。main WebView reload重新创建TypeScript Providers并恢复已提交布局。

Renderer拥有的未提交状态具有恢复风险：

- dirty File Editor buffer。
- Terminal Canvas scrollback。
- 尚未flush的Dock layout。
- 正在进行的dialog或drag操作。

最近ACK报告dirty editor和live Shell runtime数量。存在dirty editor时仅显示原生恢复提示；首版不执行静默reload。

## Automatic recovery guard

后续自动soft reload同时满足以下条件：

- 主窗口visible且非minimized。
- 连续10秒没有renderer ACK。
- 最近ACK的dirty editor数量为0。
- 当前没有application shutdown或installer操作。
- 5分钟内自动reload次数少于2次。

自动恢复先写诊断，再执行reload。连续失败进入`RecoveryFailed`并停止自动动作，防止reload loop。

完整进程重启不属于首版自动恢复。它会停止Shell和Agent process trees，并可能丢失renderer-only状态。

## External guardian

未来`ccsm-guardian`通过Named Pipe或Unix socket接收Rust process heartbeat。进程超时后，guardian保存OS诊断、终止精确stale PID、等待database/profile locks释放，再启动一个recovery instance。

Guardian使用single-instance lock确保一个`data.db` writer。它只处理Rust process crash或native process hang；renderer-only故障继续由主进程内monitor处理。

Guardian重启预算为5分钟内最多2次。超过预算后保留诊断并等待用户显式启动。

## Click simulation

健康监控不注入真实鼠标点击。真实点击可能触发关闭、删除、提交或外部导航，并改变用户焦点。

Synthetic DOM `element.click()`绕过hit testing和OS→WebView输入路由，不能证明物理点击链路健康。Input path通过capture-phase journal、pointer capture状态和stale transient状态判断。

## Platform adapters

共享monitor contract覆盖Windows、macOS和Linux：probe nonce、ACK、状态机、诊断schema和恢复预算保持一致。

- Windows adapter补充WebView2 renderer process信息和native notification。
- macOS adapter补充WKWebView process状态和NSApplication recovery affordance。
- Linux adapter补充WebKitGTK process状态和desktop notification。

Windows首先实现并完成验收。其他平台在启用自动恢复前通过相同场景矩阵。

## Verification

L1使用fake clock验证状态机、迟到ACK、宽限期和restart budget。

L2使用desktop adapter fixture验证probe/ACK DTO、日志schema和main WebView reload协调。

L3验证Rust monitor在renderer不回应时仍能写诊断并触发native恢复入口。

L4 Desktop Scenario覆盖：

- JavaScript long task导致ACK超时，解除后恢复Healthy。
- renderer持续阻塞，soft reload创建新renderer并收到ACK。
- minimized、lock/sleep和debugger pause不产生误恢复。
- dirty editor阻止静默reload并显示native提示。
- pointer capture和Dock drag异常产生`InputPathSuspect`。
- 两次恢复失败触发loop breaker。
- Shell和Agent runtime在soft reload期间保持同一runtime ID。

Development Testing使用`playwright-cli`读取health state、注入确定性fixture和核对诊断文件。真实用户长期运行实例仅使用targeted eval和native导出，不采集终端或文件内容。
