# CCSM v2 repository

`specs/` is the product and architecture source of truth. Read the relevant specification before changing behavior.

## Workspace boundaries

- `crates/ccsm-core` owns domain models, application services, ports, DTOs, and AppEvents. Its dependency graph stays Tauri-free.
- `crates/ccsm-platform` implements SQLite, PTY/process, filesystem, Git, paths, CLI shim, and HookEndpoint ports. It contains no Window, WebView, renderer, or BrowserSurface types.
- `apps/desktop/src-tauri` is the Tauri composition root and owns commands, events, channels, windows, BrowserSurfaceManager, and BrowserProfileManager.
- `apps/desktop/src` owns the TypeScript store, Dockview layout, built-in TabProviders, ghostty-web terminals, and typed desktop clients.
- Production code may copy validated prototype sources and notices into this repository. Runtime and build dependencies never point to `../prototypes` or `../research`.

## Contracts

- TypeScript application code uses `CcsmDesktopClient`. Raw Tauri `invoke`, `Channel`, and event registration stay in `apps/desktop/src/transport`.
- User mutations update the store from committed command responses. AppBackend and browser host changes arrive through `DesktopEventStream`. PTY bytes use a binary Channel.
- Rust DTOs generate the TypeScript files under `apps/desktop/src/generated`; generated files are not edited by hand.
- Browser host DTOs live in `ccsm-desktop`; browser native types never enter core/platform.

## State and lifecycle

- `data.db` is the only SQLite database. Runtime handles, PID, PTY, mutexes, watch scopes, and native WebViews stay in memory.
- `runtime_id` is the sole identity for one PTY/process-tree lifetime.
- Claude/Codex/Copilot native Session IDs only come from authenticated HookReports. Never scan provider directories or transcripts to infer identity.
- Normal and abnormal application exits must clean spawned process trees and native surfaces.

## Development

- Run `pnpm dev` from the repository root for the normal desktop development loop. It starts `tauri dev`, which starts the Vite server through `beforeDevCommand`; TypeScript and CSS changes use Vite HMR in the running desktop window.
- `pnpm dev` owns the frontend iteration loop. `pnpm desktop:build:debug` provides final build verification.
- Rust or Tauri host changes may trigger a native rebuild/restart under `tauri dev`; frontend-only changes stay on the existing HMR instance. Keep one dev instance per workspace so Vite ports and WebView profiles remain uniquely owned.
- Use Microsoft [`playwright-cli`](https://github.com/microsoft/playwright-cli) for interactive inspection of the running dev WebView. Check for `playwright-cli` before use; when the command is unavailable, prompt the user to install it with `npm install -g @playwright/cli@latest`.
- Start `pnpm dev`, then attach a named CLI session with `playwright-cli -s=ccsm-dev attach --cdp=http://127.0.0.1:9226`. Use `playwright-cli -s=ccsm-dev detach` when inspection is complete so the developer-owned Tauri process keeps running.
- Deliver vertical slices across core, platform, desktop adapter, TypeScript Provider, and tests.
- Keep platform conditionals in platform modules or `ccsm-desktop/browser`; preserve shared domain behavior.
- Preserve vendored ghostty-web CJK, selection, box-drawing, and IME fixes, plus portable-pty/ConPTY notices and integrity checks.
- Run formatting, Rust tests, TypeScript checks, deterministic terminal regressions, and a desktop build before handoff.

## Desktop testing

- Use WebdriverIO with `@wdio/tauri-service` and the embedded provider for local Desktop E2E debugging and GitHub Actions. Windows and Linux share the WDIO configuration, scenarios, fixtures, selectors, assertions, and reporters.
- Playwright CLI sessions own interactive exploration of an existing `pnpm dev` WebView. WDIO scenarios own repeatable assertions, regression coverage, and gate results.
- Build a dedicated E2E executable with the Cargo `e2e` feature. The feature enables `tauri-plugin-wdio-webdriver` and `tauri-plugin-wdio`; normal dev and release builds use the default feature set.
- Use `pnpm test:desktop:build` to build the current-platform E2E executable, `pnpm test:desktop` to run the suite, and `pnpm test:desktop:debug -- --spec <file>` to debug one scenario locally.
- Set `CCSM_E2E_SCENARIO` to `claude`, `codex`, or `ghcp` to run one provider resume scenario. Desktop scenarios use visible WebDriver clicks and keyboard actions; internal snapshots provide diagnostics.
- Give every run isolated data, cache, runtime, Space, Browser profile, and artifact directories. The runner records and cleans every process and native surface owned by the run.
- GitHub Actions branch protection requires the Windows/Linux Verify matrix plus independent `desktop-e2e-windows` and `desktop-e2e-linux` checks. Verify owns static/default-feature tests; Desktop jobs own the platform E2E build, E2E-only backend tests, and shared Desktop Scenarios.
- Each platform job uploads structured results, screenshots, logs, cleanup evidence, and scenario GIFs through the repository-pinned `actions/upload-artifact` release with `retention-days: 7`.
- Provider E2E launches the exact Claude Code, Codex, and GitHub Copilot CLI executables pinned by `apps/desktop/e2e/provider-cli-contract/package-lock.json`. A loopback Anthropic Messages/OpenAI Responses stub validates synthetic authentication and supplies prompt-specific model responses through `CCSM_E2E_MODEL_STUB_FILE`; authenticated real Hooks own native session binding and resume evidence.
- After the E2E build, `pnpm test:provider-cli-contract` verifies package integrity, platform-specific native versions and SHA-256 values, exact production wrapper argv, real local-model requests, resume Hooks, and native resume flows for all three providers. Provider runtime homes, working directories, and Spaces live in an isolated sibling runtime outside the Git repository; uploaded artifacts contain version/hash/results and model-stub request logs.
- WDIO assertions determine the job result. PR reviewers inspect the Windows and Linux artifacts and record human acceptance through PR approval.
