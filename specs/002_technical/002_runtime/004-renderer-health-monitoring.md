# Renderer 健康监控与恢复

CCSM桌面版由Rust主进程监督可信主WebView renderer。监控协议区分JavaScript事件循环和pointer交互状态，并在恢复前保存可诊断现场。

## Ownership

```text
ccsm-desktop (Rust)
├─ RendererHealthMonitor
├─ native input observer
├─ native Reload UI button
├─ bounded diagnostic log writer
└─ reload coordinator

main WebView (TypeScript)
├─ native/DOM input correlator
├─ pointer/input journal
├─ transient interaction snapshot
└─ dirty editor/runtime risk summary
```

`RendererHealthMonitor`属于`ccsm-desktop` composition root。`ccsm-core`和`ccsm-platform`不依赖WebView、窗口或renderer健康类型。

## Health dimensions

健康状态由两个维度组成：

| 维度 | 证明方式 | 典型故障 |
| --- | --- | --- |
| Native input delivery | 原生点击与DOM capture事件形成匹配ACK | renderer hang、OS→WebView输入中断 |
| Interaction state | ACK携带pointer和transient state | stale capture、drag、resize、透明overlay |

`RendererHealthMonitor`的判定目标是用户产生真实主键点击后，主WebView完全没有响应。掉帧、交互延迟和高CPU占用不进入健康状态机。

窗口仍可拖动和CSS动画仍在播放不构成renderer健康证明。Tauri drag region由native host处理，compositor animation可在JavaScript主线程阻塞时继续运行。

## Native input probe protocol

平台adapter观察main WebView client area内的真实主键点击，并保持原始输入继续进入WebView。native title bar、窗口resize border和Tauri drag region不产生probe。

```text
native primary click observed
→ allocate monotonic inputSeq and start 1s deadline
→ emit renderer.inputProbe { inputSeq, observedAt }
→ JavaScript correlates a capture-phase DOM click from its recent input journal
→ collect interaction snapshot
→ invoke renderer_input_ack(snapshot)
→ Rust verifies inputSeq, DOM correlation and latency
```

JavaScript保存最近256条DOM输入记录。native probe和DOM click允许乱序到达，并使用button、窗口焦点和250毫秒时间窗口相关联。probe队列最多保留8项；超过上限的最旧项按timeout处理。

```ts
interface RendererInputAck {
  inputSeq: number;
  receivedAtMs: number;
  domClickObserved: boolean;
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
  liveCliRuntimeCount: number;
}
```

ACK仅包含健康元数据。target摘要只保存稳定class类别，不保存DOM文本、坐标或业务ID。终端内容、Agent prompt、文件内容、URL、剪贴板和credential不进入健康日志。

Rust使用monotonic `Instant`执行input correlation和timeout。系统时间调整不改变健康状态。

## Window lifecycle gating

主窗口处于visible、focused且非minimized状态时创建native input probe。以下转换进入宽限期：

- 应用启动或main WebView创建。
- renderer reload完成。
- Windows lock/sleep后的系统恢复。
- 窗口从minimized恢复。
- debugger暂停结束。

宽限期默认为10秒。宽限期、窗口后台或最小化期间不创建probe，也不触发自动恢复。

## Monitor state machine

```text
Starting
  ├─ one-time renderer.ready within 15s → Healthy
  └─ timeout → RecoveryFailed

Healthy
  └─ native click → AwaitingInputAck

AwaitingInputAck
  ├─ matching DOM ACK within 1s → Healthy
  └─ timeout or domClickObserved=false → InputPathSuspect

InputPathSuspect
  ├─ next matching DOM ACK → Healthy
  └─ second failed probe within 5s → InputPathUnresponsive

InputPathUnresponsive
  ├─ diagnostic capture
  ├─ native recovery affordance
  └─ reload requested → Recovering

Recovering
  ├─ one-time renderer.ready within 15s → Healthy
  └─ timeout → RecoveryFailed
```

匹配ACK重置miss counter。迟到ACK只写入诊断日志，不覆盖更新input sequence后的状态。应用启动和soft reload使用一次性`renderer.ready`握手，不恢复周期性event-loop probe。

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

匹配input ACK正常且存在stale input时，状态标记为`InputPathSuspect`。下一次干净的真实输入ACK将状态恢复为`Healthy`。

## Diagnostic capture

进入`InputPathSuspect`时Rust创建incident并把最近的内存journal写入`data.db`。后续input probe、状态转换和恢复结果使用同一个incident ID追加到单一日志表。

`renderer_health_log`的schema、8 MiB容量预算、2048行限制和7天TTL由[持久化规格](../005_data/000-persistence-ipc.md#bounded-operational-log)定义。

`event_kind`覆盖`input.timeout`、`input.lateAck`、`input.correlationFailed`、`state.changed`、`diagnostic.captured`、`recovery.requested`、`recovery.completed`和`recovery.failed`。正常匹配的点击保留在内存ring buffer；incident开始时一并写入上下文。

诊断details包含：

- CCSM version、commit、Debug/Release和平台。
- main window visible/focused/minimized状态。
- native input sequence、ACK latency和状态转换时间线。
- 最近一次RendererInputAck。
- pointer/transient ring buffer。
- Rust process和WebView2 process的PID、CPU与working set。
- active Space/Tab ID和Tab kind；不包含显示名称或内容。
- 最近100条结构化desktop event名称和correlation ID。
- recovery尝试次数与结果。

日志写入进入AppBackend现有的`data.db` single-writer队列。日志失败不阻止后续恢复动作。

## Recovery policy

Windows首版提供独立Rust/Win32 `Reload UI`按钮。按钮使用main窗口拥有的native tool window覆盖在右下角，并跟随owner的可见性与z-order；main窗口visible、focused且非minimized时显示，因此renderer无响应时仍可点击。

手动按钮与自动恢复调用同一个Rust recovery path。手动恢复不受dirty editor guard和自动reload预算限制；执行reload前先写入`diagnostic.captured`，记录trigger、前一状态、pending/missed probe、dirty editor、live CLI和最近input ACK现场，再追加`recovery.requested`。

Soft reload顺序：

```text
start buffering desktop events
→ freeze new renderer mutations
→ persist diagnostic incident
→ close transient main-WebView UI state
→ reload main WebView
→ bootstrap committed snapshot
→ replay buffered events
→ wait for one-time renderer.ready
```

AppBackend、PTY process trees、HookEndpoint和`data.db`保持存活。main WebView reload重新创建TypeScript Providers并恢复已提交布局。

Renderer拥有的未提交状态具有恢复风险：

- dirty File Editor buffer。
- Terminal Canvas scrollback。
- 尚未flush的Dock layout。
- 正在进行的dialog或drag操作。

最近input ACK报告dirty editor和live CLI runtime数量。存在dirty editor时仅显示原生恢复提示；首版不执行静默reload。

## Automatic recovery guard

后续自动soft reload同时满足以下条件：

- 主窗口visible、focused且非minimized。
- 5秒内两个真实native input probe均未获得匹配DOM ACK。
- 最近input ACK的dirty editor数量为0。
- 当前没有application shutdown或installer操作。
- 5分钟内自动reload次数少于2次。

自动恢复先写诊断，再执行reload。连续失败进入`RecoveryFailed`并停止自动动作，防止reload loop。

## Click simulation

健康监控不注入真实鼠标点击。真实点击可能触发关闭、删除、提交或外部导航，并改变用户焦点。

Synthetic DOM `element.click()`绕过hit testing和OS→WebView输入路由，不能证明物理点击链路健康。Input path由native input sequence、capture-phase DOM journal和匹配ACK共同证明。

匹配ACK证明真实输入到达DOM capture phase，不证明具体业务command已经成功提交；业务失败继续由对应command response和错误状态处理。

## Platform adapters

共享monitor contract覆盖Windows、macOS和Linux：native input sequence、DOM ACK、状态机、诊断schema和恢复预算保持一致。

- Windows adapter补充WebView2 renderer process信息和native notification。
- macOS adapter补充WKWebView process状态和NSApplication recovery affordance。
- Linux adapter补充WebKitGTK process状态和desktop notification。

Windows首先实现并完成验收。其他平台在启用自动恢复前通过相同场景矩阵。

## Verification

L1使用fake clock验证状态机、乱序/迟到ACK、宽限期、日志裁剪和自动reload预算。

L2使用desktop adapter fixture验证native input/DOM ACK DTO、日志schema、TTL和main WebView reload协调。

L3验证native input已到达而renderer不回应时，Rust monitor仍能写入有界日志并触发native恢复入口。

L4 Desktop Scenario覆盖：

- native点击与DOM click形成匹配ACK并保持Healthy。
- renderer持续阻塞时，两个真实点击无ACK并触发soft reload。
- OS→WebView输入中断时，ACK报告`domClickObserved=false`。
- native `Reload UI`按钮在renderer无响应时仍可触发同一soft reload，并在DB保存manual trigger现场。
- minimized、lock/sleep和debugger pause不产生误恢复。
- dirty editor阻止静默reload并显示native提示。
- pointer capture和Dock drag异常产生`InputPathSuspect`。
- 两次恢复失败触发loop breaker。
- Shell和Agent runtime在soft reload期间保持同一runtime ID。

Development Testing使用`playwright-cli`读取health state、注入确定性fixture和核对`renderer_health_log`。真实用户长期运行实例仅使用targeted eval和native导出，不采集终端或文件内容。
