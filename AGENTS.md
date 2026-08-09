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
- Claude/Codex native Session IDs only come from authenticated HookReports. Never scan provider directories or transcripts to infer identity.
- Normal and abnormal application exits must clean spawned process trees and native surfaces.

## Development

- Deliver vertical slices across core, platform, desktop adapter, TypeScript Provider, and tests.
- Keep platform conditionals in platform modules or `ccsm-desktop/browser`; preserve shared domain behavior.
- Preserve vendored ghostty-web CJK, selection, box-drawing, and IME fixes, plus portable-pty/ConPTY notices and integrity checks.
- Run formatting, Rust tests, TypeScript checks, deterministic terminal regressions, and a desktop build before handoff.
- Use the installed `playwright-cli` skill for interactive WebView verification; do not add bespoke Playwright runner scripts.
