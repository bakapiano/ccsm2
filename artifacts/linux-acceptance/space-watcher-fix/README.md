# Linux Space watcher activation regression

## Result

PASS. A Space named `lib.user-is-merged` can use the full
`/mnt/d/ccsmv2-linux` repository root, become active, switch back to the
previous Space, and become active again.

## Reproduction and cause

The previous Release started a recursive native watch for the complete Space
root. When the recursive native watch fell back on WSL/DrvFS, `PollWatcher`
also received `RecursiveMode::Recursive` with a two-second interval. The
initial invocation synchronously walked `node_modules/.pnpm` before bootstrap
could return. One walk took about five minutes, while the next polling walk
started immediately afterward and kept the process busy.

This caused four connected symptoms:

1. first launch remained at `Opening Space...`;
2. creating a Space waited inside root activation;
3. switching Space waited on the same activation path;
4. a restart reopened the persisted active root and repeated the wait.

The fix gives every platform a non-recursive root watch during activation. File
Explorer directory loads, File Editor reads/writes, and Git repository
coordination materialize bounded non-recursive scopes. The polling fallback
uses the same scopes.

## Desktop acceptance

Environment: Ubuntu 24.04 under WSLg, WebKitGTK, Tauri debug binary with the
embedded production frontend, isolated `CCSM_DATA_DIR`.

- cold start from `/mnt/d/ccsmv2-linux`: UI and Browser ready within the
  four-second capture window;
- opened `node_modules` file descriptors after ready: `0`;
- create `lib.user-is-merged` at the full repository root: `193 ms`;
- switch to `desktop`: samples `172 ms` and `411 ms`;
- switch to `lib.user-is-merged`: samples `133 ms` and `152 ms`;
- both Shell sessions retained their runtime identity across detach/remount;
- WebKitGTK Browser returned visible and ready after every switch;
- SQLite retained both layouts, both desired-running CLI sessions, and the
  final active Space.

## Extracted Release acceptance

The final Ubuntu archive was built from fix commit `f46345a` and extracted to
a fresh directory before launch.

- source revision: `v0.1.0-beta.2-11-gf46345a`;
- archive bytes: `3201399`;
- archive SHA-256:
  `96e253ea94390aad9d11f0528c0bc13e3f134355a9db44dce9abc2a4ba8fe78c`;
- extracted binary SHA-256:
  `36d556f12a8e43ebf9aec6440a1d5991a5cdd17962030b50b8e800682f546f51`;
- full repository cold start: ready within the four-second capture window;
- opened `node_modules` file descriptors after ready: `0`;
- create `lib.user-is-merged`: `164 ms`;
- switch to `desktop`: `154 ms`;
- switch again to `lib.user-is-merged`: `105 ms`;
- final active root: `/mnt/d/ccsmv2-linux`;
- final Browser: `WebKitGTK · ready`, visible;
- both CLI sessions: desired state `running`.

The desktop state transitions were exercised through the native Tauri
WebDriver protocol. The repository's WDIO entrypoint was also attempted; its
Node process remained in WSL `p9_client_rpc` while loading dependencies from
the Windows-mounted workspace and did not launch the application. This is a
test-runner filesystem condition; the native driver session completed the
same application commands and assertions.

## Screenshots

- [Before: bootstrap waiting](before-fix-opening-space.png)
- [Fixed cold start at four seconds](cold-start-4s-composited.png)
- [Created `lib.user-is-merged`](after-created-composited.png)
- [Switched back to `desktop`](after-switched-back-composited.png)
- [Switched again to `lib.user-is-merged`](after-switched-again-composited.png)
- [Extracted Release cold start at four seconds](release-cold-start-4s-composited.png)
- [Extracted Release after bidirectional switch](release-after-switched-again-composited.png)

## Automated gates

- `cargo test --workspace`: passed;
- `cargo check --workspace`: passed;
- watcher adapter regressions: root, materialized nested scope, inaccessible
  descendant all passed;
- backend scope routing and Space activation rollback regressions passed;
- `pnpm --filter @ccsm/desktop check`: passed;
- frontend tests: `252 passed, 0 failed`;
- Rustfmt, Prettier, and `git diff --check`: passed.

## Cross-platform extension

The same bounded watcher behavior passed native Windows adapter and desktop
acceptance. See the [Windows evidence bundle](../../windows-acceptance/space-watcher-fix/README.md).
