# Linux / WSLg acceptance evidence

Acceptance was performed on 2026-08-13 from source commit
`60e623af8e120fa52880e7d023bb4ef48e573bda` (`feat/linux-desktop-support`).
The host and toolchain versions are recorded in [environment.txt](environment.txt).
A Space create/switch regression follow-up was performed on 2026-08-14 on the
same branch and environment.

## Ubuntu release archive

- Release: [v0.1.0-beta.2-ubuntu](https://github.com/bakapiano/ccsm2/releases/tag/v0.1.0-beta.2-ubuntu)
- Archive: [CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64.tar.gz](https://github.com/bakapiano/ccsm2/releases/download/v0.1.0-beta.2-ubuntu/CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64.tar.gz)
- Checksum: [CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64.tar.gz.sha256](https://github.com/bakapiano/ccsm2/releases/download/v0.1.0-beta.2-ubuntu/CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64.tar.gz.sha256)
- Archive SHA-256: `fde54d572d490da93f258e979bfe33f8c3a96e13a76aa46e63dfd9db28e9df7a`
- Archive size: 3,180,927 bytes
- Binary SHA-256: `a8a3f7945afdfd9c9bb213d228f37166e4d82267084720579764a24df3da97b5`
- Build metadata: [BUILD-INFO.txt](release/BUILD-INFO.txt)

The archive checksum, executable modes, runtime library resolution, and `run.sh`
layout were checked after extraction. The extracted release binary completed the
WebDriver browser/menu/geometry/overlay scenario with one passing test.

## WSLg browser bridge

| Scenario                                                                   | Evidence                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| WebKitGTK browser renders `https://example.com/` inside the CCSM layout    | [live WSLg capture](browser/browser-live.png)                     |
| Native browser remains correctly placed while the New Tab menu overlays it | [composited WSLg capture](browser/browser-overlay-composited.png) |
| Extracted release opens the New Tab menu                                   | [release capture](release/new-tab-menu.png)                       |
| Extracted release Browser overlay snapshot                                 | [WebDriver capture](release/browser-overlay-webdriver.png)        |
| Renderer and native browser allocation                                     | [renderer-geometry.json](release/renderer-geometry.json)          |

The recorded renderer viewport is 1320 x 800 at device pixel ratio 1. The native
Browser allocation is x=776, y=103, width=544, height=675.

## Space create and switch permission regression

The reproduced path created a Space rooted at `/etc`. The native recursive
watcher reached `/etc/ssl/private` and returned `Permission denied` after SQLite
had already selected the new Space. The pre-fix UI stayed on `desktop` while the
database selected the new `/etc` Space. The exact renderer state and error are
recorded in [before-fix-ui.json](space-flow/before-fix-ui.json), with the
corresponding [renderer screenshot](space-flow/before-fix-renderer.png).

The fix falls back to a recursive polling watcher for roots containing
inaccessible descendants. AppBackend also restores the prior active Space when
root activation fails and removes a partially created Space graph. Integration
tests force watcher rejection and verify both rollback paths.

The Linux desktop regression then completed `create -> switch back -> switch
again` with `/etc`:

| State                         | WSLg composite                                                          | Renderer state                                                   |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| New `/etc` Space active       | [screenshot](space-flow/after-created-composited.png)                   | [after-created.json](space-flow/after-created.json)               |
| Initial Space active again    | [screenshot](space-flow/after-switched-back-composited.png)             | [after-switched-back.json](space-flow/after-switched-back.json)   |
| New `/etc` Space active again | [screenshot](space-flow/after-switched-again-composited.png)            | [after-switched-again.json](space-flow/after-switched-again.json) |

Both state pairs retain their original Shell runtime ID. Every state records
`browserNativeVisible: true`, `WebKitGTK · ready`, and global status `ready`.
The final SQLite rows are captured in
[database-state.txt](space-flow/database-state.txt), the interaction timestamps
in [steps.txt](space-flow/steps.txt), and the complete gate summary in
[result.txt](space-flow/result.txt).

## Real CLI turn and resume

Each provider completed a first GUI turn, stopped, resumed the same native CLI
session, completed a second GUI turn, and released its runtime process group and
watchdog. Process evidence records PID, PPID, PGID, SID, state, command, and
arguments.

| Provider                  | Turn 1                                    | Resumed turn 2                                   | Process trees                                                                                                             |
| ------------------------- | ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.229       | [screenshot](providers/claude-turn1.png)  | [screenshot](providers/claude-resume-turn2.png)  | [turn 1](processes/claude-turn1.txt), [resumed](processes/claude-resumed.txt), [stopped](processes/claude-stopped.txt)    |
| Codex CLI 0.147.0         | [screenshot](providers/codex-turn1.png)   | [screenshot](providers/codex-resume-turn2.png)   | [turn 1](processes/codex-turn1.txt), [resumed](processes/codex-resumed.txt), [stopped](processes/codex-stopped.txt)       |
| GitHub Copilot CLI 1.0.79 | [screenshot](providers/copilot-turn1.png) | [screenshot](providers/copilot-resume-turn2.png) | [turn 1](processes/copilot-turn1.txt), [resumed](processes/copilot-resumed.txt), [stopped](processes/copilot-stopped.txt) |

Provider acceptance used isolated CCSM data directories and the existing local
CLI authentication/configuration. The committed evidence contains provider names,
session identifiers, command structure, and test markers. Credential values are
kept in the local test environment.

## Process release after desktop SIGKILL

The abnormal-exit scenario opened a Shell runtime, started `sleep 600`, recorded
the desktop and every descendant, sent SIGKILL to the desktop process, and waited
for every recorded PID, runtime process group, and watchdog to disappear.

- Result: [result.txt](abnormal-exit/result.txt)
- Recorded identities: [identities.json](abnormal-exit/identities.json)
- Before SIGKILL: [before-sigkill.txt](abnormal-exit/before-sigkill.txt)
- After SIGKILL: [after-sigkill.txt](abnormal-exit/after-sigkill.txt)
- Shell state after starting the long child: [shell-after-command.json](abnormal-exit/shell-after-command.json)

The recorded set contains the desktop, WebKit processes, two Shell runtime
process groups, their watchdogs, and the long-running child. The after snapshot
contains the header only, and the automated result is `PASS`.

## Validation commands

The following gates completed successfully:

- Ubuntu: `pnpm check`
- Ubuntu: `pnpm test` (all Rust workspace suites and 252 frontend tests)
- Ubuntu: `pnpm build`
- Ubuntu: `pnpm desktop:build:debug`
- Ubuntu: `pnpm desktop:build:release`
- Ubuntu: provider WebDriver scenarios for Claude, Codex, and Copilot (one passing scenario per provider)
- Ubuntu: abnormal desktop-exit WebDriver scenario (one passing scenario)
- Ubuntu: extracted release browser WebDriver scenario (one passing scenario)
- Ubuntu: `/etc` Space create and bidirectional switch WebDriver scenario (one passing scenario)
- Ubuntu: Space activation rollback integration tests (two passing scenarios)
- Windows: `cargo check --workspace`
- Formatting: `cargo fmt --all -- --check` and Prettier checks
- Packaging scripts: Bash syntax, ShellCheck when available, and PowerShell parser checks
