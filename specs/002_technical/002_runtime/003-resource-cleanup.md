# Resource Cleanup

Tauri Rust主进程提供一个幂等`shutdown()`，在Close Main Window、Quit、应用内updater安装、installer请求退出和OS shutdown signal时执行。

## Ownership

```text
ccsm-desktop
├─ application process-tree guard
├─ main window/WebView
├─ native child WebViews
├─ BrowserProfileManager
└─ Tauri channels/listeners

AppBackend
├─ RuntimeManager
├─ AgentGatewayService
├─ ActiveRootContext?
├─ background tasks
├─ RuntimeReportEndpoint
└─ StateStore
```

`ccsm-desktop`持有UI/native handles，并调用`AppBackend.shutdown()`释放业务和平台资源。`ccsm-core`只暴露shutdown service contract。

Windows桌面入口在创建Tauri、WebView2和PTY之前安装application Job Object，将桌面进程加入Job并保持handle直到进程死亡。随后创建的WebView2、OpenConsole和CLI进程继承该Job。每个CLI runtime继续使用嵌套的runtime Job支持单独Stop。

## Shutdown sequence

```text
enter the idempotent shutdown gate
→ persist current Space/Tab layout
→ close native child WebViews
→ flush global Browser Profile
→ stop all RuntimeManager entries
→ send gateway.shutdown and close Gateway Provider connections
→ wait up to 3 seconds, then terminate the Gateway process tree
→ join PTY input/resize/reader/waiter threads
→ drop PTY master and call ClosePseudoConsole
→ close ActiveRootContext and cancel background tasks
→ close RuntimeReportEndpoint
→ commit pending state and checkpoint WAL
→ close data.db connection
→ close Tauri channels/window
```

重复调用`shutdown()`加入同一个future。每个步骤记录结果并继续执行后续cleanup。

单个PTY cleanup使用从stop开始计算的3秒共享deadline。process-tree terminate、reader/waiter watchdog和thread join共同消耗该预算；deadline到达时返回明确cleanup error并释放调用线程，后台OS cleanup guard继续持有process-group终止职责。

## CLI process trees

每个runtime使用平台`ProcessTree`执行：

```text
soft interrupt
→ terminate process tree
→ hard kill remaining descendants
→ reap and record exit result
```

Windows使用per-runtime Job Object。macOS/Linux使用process group signals和平台process inspection。应用退出写入`exit_reason=application_shutdown`并保留`CliSession.desired_state`；用户显式Stop同时写入`desired_state=stopped`。

用户关闭CLI Tab时，AppBackend先停止对应process tree，再在同一存储事务中删除Tab和CliSession。关闭Browser Tab时，提交Tab删除后关闭对应native WebView。关闭失败时前端恢复Panel，避免布局和durable state分叉。

## Space Delete

Space Delete调用scoped cleanup：关闭该Space的Browser surfaces、停止其CLI trees、取消Tab tasks、删除durable records，并同步清理可重建cache和Space-owned artifacts。磁盘SpaceRoot、global Browser Profile和provider transcripts保持。

## Abnormal process exit

Windows application Job Object启用kill-on-close。桌面进程被强杀或崩溃时，Windows同步终止Agent Gateway、WebView2、OpenConsole和全部CLI descendants。非Windows平台使用各自的process-group/watchdog实现同一contract；平台实现状态记录在跨平台能力矩阵中。runtime ownership不写入数据库。

runtime shim root使用`ccsm-runtime-shims-<owner_pid>`命名。Windows启动时扫描直接子目录，仅清理由死亡owner PID留下的合法shim root；活跃PID、符号链接和无关名称保持原状。`data.db`和global Browser Profile属于持久数据。
