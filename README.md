# CCSM v2

CCSM is a cross-platform desktop workspace for persistent layouts containing CLI sessions, native browser tabs, files, and Git status.

## Repository

- `specs/` — product, architecture, and testing specifications.
- `crates/ccsm-core/` — domain model, application services, ports, and DTOs.
- `crates/ccsm-platform/` — SQLite, PTY/process, filesystem, Git, paths, and Hook adapters.
- `apps/desktop/` — TypeScript renderer and Tauri desktop host.
- `tests/` — cross-crate and desktop scenarios.

## Commands

```powershell
pnpm install
pnpm dev                 # Tauri desktop + Vite frontend HMR
pnpm check
pnpm test
pnpm build
pnpm desktop:build:debug # final debug executable verification
```

Architecture starts at [specs/README.md](specs/README.md).

## Windows beta

Download the Windows x64 ZIP from [GitHub Releases](https://github.com/bakapiano/ccsm2/releases), extract the complete archive, and run `ccsm-desktop.exe`. Keep the bundled `conpty/` directory beside the executable.

Windows 10 version 1809 or newer is required. The Microsoft Edge WebView2 Runtime and the CLI providers you want to use (`codex`, `claude`, and `copilot`) must be available on the machine.

Build a release archive locally with:

```powershell
pnpm package:windows
```
