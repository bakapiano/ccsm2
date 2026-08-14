# Linux / WSLg acceptance evidence

Acceptance was performed on 2026-08-13 from source commit
`60e623af8e120fa52880e7d023bb4ef48e573bda` (`feat/linux-desktop-support`).
The host and toolchain versions are recorded in [environment.txt](environment.txt).
A Space create/switch regression follow-up was performed on 2026-08-14 on the
same branch and environment.
A second 2026-08-14 L4 expansion exercised Space Folder management, File
Explorer, File Editor, Git, restart recovery, and the Agent sidebar against an
isolated Linux Release build.

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

### Current PR Release rebuild

The follow-up Release archive was rebuilt from source `v0.1.0-beta.2-9-g8062082`
after the Space and hidden-runtime fixes:

- Archive bytes: `3,192,823`
- Archive SHA-256: `ea9e7413fad87e2dac31351bdc227db0f5dbe31c1a57745512499e382c776974`
- Binary SHA-256: `6a6f5870cefa613f767c70d03139d1c063eded1a51efc8e3ef234309a995fb99`
- [build metadata](release-current/BUILD-INFO.txt)
- [archive and binary hashes](release-current/archive-info.txt)
- [runtime library resolution](release-current/ldd.txt)

The archive checksum, `0755` binary/launcher modes, and dynamic libraries were
verified after extraction. That extracted binary completed the `/etc` Space
create and bidirectional switch scenario with one passing test:

| State                         | Screenshot                                                               | Renderer state                                                     |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| New `/etc` Space active       | [renderer](release-current/space-flow/space-created-renderer.png)        | [state](release-current/space-flow/space-created.json)              |
| Initial Space active again    | [renderer](release-current/space-flow/space-switched-back-renderer.png)  | [state](release-current/space-flow/space-switched-back.json)        |
| New `/etc` Space active again | [renderer](release-current/space-flow/space-switched-again-renderer.png) | [state](release-current/space-flow/space-switched-again.json)       |

The same binary SHA produced the final Workspace, restart recovery, and Agent
evidence below.

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

## Workspace, File Editor, and Git workflows

The workspace L4 scenario used an isolated Git repository and completed three
passing tests. It created, renamed, collapsed, expanded, and deleted Space
Folders; dragged a Space into a Folder, back to Unfiled, and into the Folder
again; opened the same file twice through File Explorer and retained one Editor
Tab; edited Unicode text; exercised Dirty close Cancel; saved CRLF bytes; and
refreshed Git to `1 repos · 1 changes`.

| State                                      | Evidence                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Space nested in renamed Folder             | [screenshot](workspace-flow/space-inside-folder.png)                   |
| Folder delete confirmation                 | [screenshot](workspace-flow/folder-delete-confirmation.png)            |
| Folder collapsed after persisted move      | [screenshot](workspace-flow/space-folder-collapsed.png)                 |
| CodeMirror Unicode edit is Dirty           | [screenshot](workspace-flow/editor-dirty.png)                           |
| Dirty close offers Save/Discard/Cancel      | [screenshot](workspace-flow/editor-close-cancel.png)                    |
| Saved Editor retains Unicode and CRLF       | [screenshot](workspace-flow/editor-saved.png)                           |
| Git renders `acceptance.md` as modified     | [screenshot](workspace-flow/git-change.png)                             |
| Final restorable renderer and runtime state | [workspace-before-restart.json](workspace-flow/workspace-before-restart.json) |

The complete runner result is in
[result.txt](workspace-flow/result.txt), with the raw WDIO output in
[workflow-wdio.txt](workspace-flow/workflow-wdio.txt).

## Workspace restart recovery

The first restart probe restored the active Space, Folder placement, File
Editor contents, word-wrap state, and native Browser, while the hidden Shell
reported `shellRuntimeId: null` after 45 seconds despite persisted
`desired_state=running`. The exact six-part state is retained in
[before-fix.json](workspace-recovery/before-fix.json) and the corresponding
[screenshot](workspace-recovery/before-fix.png).

`shouldAutoStartCliRuntime` now starts persisted running Sessions before their
restored terminal Tab becomes visible. The terminal uses its default 80×24 grid
until a visible viewport supplies the final fit. Re-running the same persisted
workspace completed in 2.7 seconds with a new Shell runtime ID while preserving
the active File Editor and Browser:

- [restored desktop screenshot](workspace-recovery/workspace-after-restart.png)
- [restored state](workspace-recovery/workspace-after-restart.json)
- [runner result](workspace-recovery/result.txt)

## Agent cross-Space focus and deletion

The Agent L4 scenario launched the installed Codex CLI without submitting a
model turn, switched to another Space while its runtime remained alive, clicked
the Agent sidebar entry to return to the owning Space and Tab, and exercised the
two-stage close flow.

| State                                         | Evidence                                                         |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Codex Agent appears and is foreground         | [screenshot](agent-flow/agent-running.png)                        |
| Agent remains listed from another Space       | [screenshot](agent-flow/agent-from-other-space.png)               |
| Agent click restores owning Space and Tab      | [screenshot](agent-flow/agent-cross-space-focused.png)            |
| Close confirmation keeps Panel/runtime mounted | [screenshot](agent-flow/agent-close-confirmation.png)             |
| Confirmed deletion removes the Agent           | [screenshot](agent-flow/agent-closed.png)                          |

Cancel retained the Tab, Session, Agent item, and original runtime ID. Confirm
deleted the Codex Tab and CLI Session from `data.db`; process group `18670` and
its watchdog went from the recorded tree in
[agent-processes-before-close.txt](agent-flow/agent-processes-before-close.txt)
to the header-only
[agent-processes-after-close.txt](agent-flow/agent-processes-after-close.txt).
The final UI/process identity state is in
[agent-after-close.json](agent-flow/agent-after-close.json).

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
- Ubuntu: final extracted Release `/etc` Space create and bidirectional switch (one passing scenario)
- Ubuntu: Space Folder/File Explorer/File Editor/Git WebDriver workflow (three passing scenarios)
- Ubuntu: persisted workspace restart recovery WebDriver scenario (one passing scenario)
- Ubuntu: Codex Agent cross-Space focus, close Cancel, deletion, and process cleanup WebDriver scenario (one passing scenario)
- Ubuntu: Space activation rollback integration tests (two passing scenarios)
- Windows: `cargo check --workspace`
- Formatting: `cargo fmt --all -- --check` and Prettier checks
- Packaging scripts: Bash syntax, ShellCheck when available, and PowerShell parser checks
