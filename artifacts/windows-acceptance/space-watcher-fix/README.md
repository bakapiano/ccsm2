# Windows Space watcher acceptance

## Result

PASS. Windows uses the same shallow Space-root watcher and bounded materialized
scopes as Linux. A Space named `lib.user-is-merged` can use the full
`D:\ccsmv2-linux` repository root, become active, switch to the original Space,
and become active again.

## Environment

- native Windows `ccsm-desktop.exe` debug build;
- embedded production frontend through Tauri `custom-protocol`;
- WebView2 `151.0.4129.86`;
- isolated data directory:
  `C:\Users\jiannanli\AppData\Local\ccsm-windows-watcher-pr6-20260814`;
- Playwright CLI attached to the test-only WebView2 CDP port `9236`.

The repository configuration was restored to its normal CDP port after the
test binary was built.

## Desktop acceptance

- initial Space root: `D:\ccsmv2-linux`;
- initial UI, Shell, and WebView2 reached ready state;
- create `lib.user-is-merged` at the full repository root: `119 ms`;
- switch to `lib.user-is-merged`: `128 ms`;
- switch to the original Space: `129 ms`;
- switch again to `lib.user-is-merged`: `157 ms`;
- final active Space: `lib.user-is-merged`;
- final Shell: running;
- final Browser: `WebView2 · ready` and visible.

## Native adapter gates

`cargo test -p ccsm-platform` passed natively on Windows:

- platform unit tests: `32`;
- Space activation and scope routing: `3`;
- process tree guard: `3`;
- PTY lifecycle: `2`;
- filesystem, Git, root watcher, and nested materialized watcher: `4`;
- SQLite store: `13`.

The Windows run also covered canonicalized path comparison in Space activation
rollback fixtures.

## Screenshot

- [Composited native window after bidirectional switching](windows-after-switch-composited.png)
- [Main WebView after bidirectional switching](windows-webview-after-switch.png)
