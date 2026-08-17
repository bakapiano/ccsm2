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

## Ubuntu 24.04 preview

CCSM runs on Ubuntu 24.04 x86_64 and WSLg with the WebKitGTK, GTK, AppIndicator,
SVG, and xdo runtime libraries installed. Claude Code, Codex, and GitHub Copilot
tabs use their authenticated Linux CLI installations from `PATH`.

Build the tested `tar.gz` archive from Ubuntu or WSL Ubuntu with:

```bash
pnpm package:ubuntu
```

The archive and its SHA-256 file are written to `target/release/`. Its packaged
`README-UBUNTU.md` contains the runtime dependency and launch commands.

## Automated releases

Pull requests and `main` run the Windows and Ubuntu CI matrix. Pushing an
annotated `v<version>` tag whose version matches the repository manifests runs
the full quality gate, builds both native archives, verifies their contents,
creates SHA-256 files and provenance attestations, and publishes a GitHub
pre-release when the version contains a prerelease suffix.

Same-repository pull requests publish their Windows and Linux Desktop E2E
evidence to an active-PR report on GitHub Pages.
