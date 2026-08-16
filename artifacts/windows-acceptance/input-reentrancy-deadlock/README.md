# Windows input reentrancy deadlock acceptance

## Result

PASS. Full-memory dumps of a frozen `0.1.0-beta.3` Release host and a
controlled reproduction identify a same-thread Win32 input reentrancy deadlock
in Tao 0.35.3. The final `0.1.0-beta.6` Release uses the exact official Tao
fix revision and completed three identical 15-second rounds while every
activity, responsiveness, posted-message quality, and cleanup gate passed.

## Environment and binaries

- Windows x64, OS build `26200`;
- WinDbg `10.0.29617.1000`;
- frozen binary: `0.1.0-beta.3`, `5,880,832` bytes, SHA-256
  `3516f28dab4c82cef1eedc0a1461f821e06637ba42439c0ba1ec401c3bede781`;
- fixed binary: `0.1.0-beta.6`, `8,247,296` bytes, SHA-256
  `cab8b0165fd65f61c35dea5be876a67fcb9022c7e83e81802a359f6682305d37`,
  built from clean source commit
  `a281585dabc0fd67aa7ce51e706dfdee3fc0675b` after merging
  `origin/main` at `15686cd`.

## Production hang capture

The already-frozen beta.3 process tree was sampled at
`2026-08-16T00:28:13.8991178+08:00`:

- host window responding: `false`;
- processes: `48`;
- aggregate working set: `3,552,780,288` bytes;
- aggregate private bytes: `2,038,972,416` bytes;
- threads: `907`;
- handles: `17,262`.

Three full-memory dumps were captured and hashed:

- production host: `154,976,252` bytes, SHA-256
  `58c9cb8e962d978ef823108167b5e1485cc827206968590ab7ac0e070c7507c7`;
- production WebView renderer: `1,146,670,418` bytes, SHA-256
  `08b9d946faf43a261407cd3d04039a1d447a15a88f7d054cdee393c542942d57`;
- controlled beta.3 host: `125,984,564` bytes, SHA-256
  `6d2a3025681f5a71bfd5789fee736588b70e3f14fc93ee8494ac78d6c4fbe32e`.

The full-memory dumps remain in local diagnostic storage because process
memory can contain user content. Their sanitized stacks, sizes, hashes, and
derived lock state are recorded in this directory.

## Root cause

The production host dump and the controlled reproduction dump show the same
native UI-thread sequence:

1. Tao holds its global `KEY_EVENT_BUILDERS` `parking_lot::Mutex` while
   processing `WM_KEYUP` (`0x0101`).
2. Tao calls `PeekMessageW` while that guard is live.
3. Win32 dispatches a synchronous `WM_KILLFOCUS` callback on the same thread.
4. The reentrant callback attempts to acquire `KEY_EVENT_BUILDERS` again.
5. The native UI thread parks in `WaitOnAddress` forever because the mutex is
   non-reentrant and its owner is the same blocked thread.

The beta.3 production dump pins the relevant code and state:

- outer return after `PeekMessageW`: module RVA `0x2b9271`;
- reentrant mutex slow-path return: module RVA `0x2b9cfd`;
- `KEY_EVENT_BUILDERS` mutex: module RVA `0x578790`;
- mutex state byte: `0x03` (`LOCKED | PARKED`);
- outer message: `0x0101` (`WM_KEYUP`);
- reentrant message: `0x0008` (`WM_KILLFOCUS`).

The WebView renderer/compositor runs in a separate process, so rendered frames
can continue while the native host UI thread is deadlocked. During a controlled
beta.3 freeze, a CDP frame probe advanced `requestAnimationFrame` by `937.4 ms`
over a `900 ms` observation while the host window stayed unresponsive.

Tao fixed this exact lock ordering in upstream commit
[`c704261c`](https://github.com/tauri-apps/tao/commit/c704261c519c58cfdd0bc2d58ba24e06a0b71c92),
`fix(windows): avoid reentrant input lock deadlocks (#1215)`. The fix performs
keyboard and IME message peeks before acquiring the non-reentrant input-state
locks. Tao released the fix in
[`tao-v0.36.0`](https://github.com/tauri-apps/tao/releases/tag/tao-v0.36.0).

Tauri `2.11.5`, JavaScript API `2.11.1`, and CLI `2.11.4` were the latest
stable releases at verification time. Published `tauri-runtime-wry` `2.11.4`
constrains Tao to `^0.35.0`, so CCSM retains the published stable runtime and
patches Tao to the official upstream revision `c704261c`. The locked graph
resolves `tauri-runtime` `2.11.3`, `tauri-runtime-wry` `2.11.4`,
`tauri-utils` `2.9.3`, and Wry `0.55.1` from crates.io, plus Tao `0.35.3`
from the official `tauri-apps/tao` repository at that exact revision. The
dependency gate reads Cargo metadata and verifies the actual package IDs and
edges from `ccsm-desktop` through `tauri-runtime-wry` to Tao and Wry.

The workspace MSRV is Rust `1.88` and the repository toolchain is Rust `1.95`.
Tauri's development branch has merged
[`7cc68e74`](https://github.com/tauri-apps/tauri/commit/7cc68e74ff6981f5c50a52a67d56c5eb2d227188)
for Tao 0.36/Wry 0.56. The Cargo comment records the future upgrade condition:
use the first stable Tauri runtime resolving Tao `>=0.36.0`, then remove the
Git patch.

## Deterministic reproduction

The regression harness starts CCSM with an isolated data directory and races
three independent streams: paced posted `WM_KEYDOWN`/`WM_KEYUP`, synchronous
`WM_KEYDOWN`/`WM_KEYUP`, and synchronous `WM_KILLFOCUS`. The synchronous
keyboard stream proves that the target WndProc executed keyboard handling.
Each round requires:

- at least 100 accepted posted keyboard messages and at most 10% post failures;
- at least 100 completed synchronous keyboard messages;
- at least 10 completed synchronous focus messages;
- keyboard and focus failure streaks below 1,000 ms;
- a responsive `WM_NULL` probe, a clear `IsHungAppWindow` result, and
  `Process.Responding == true`.

```powershell
pwsh -File scripts/windows-input-deadlock-repro.ps1 `
  -Executable <release-executable> -Seconds 15 -Rounds 1
```

The harness creates the root process suspended, assigns it to a Windows Job
Object, and resumes it only after assignment. Kernel Job membership therefore
tracks every descendant even when an intermediate parent exits. Cleanup first
enables `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, captures active Job PIDs with
UTC creation-time identities, terminates the Job, waits for the root, and
requires both the Job PID list and identity survivors to become empty. A root
`Kill(true)` path remains as a recorded fallback. The Job handle closes before
profile deletion is considered.

Successful generated profiles are removed only after the full cleanup result
has no errors. Every failed run retains its generated profile for diagnosis.
`-KeepProcess` preserves the tested process tree for a dump, and `-KeepData`
preserves a successful generated profile.

Two fresh beta.3 control runs independently reproduced the freeze:

| Run | Posted / failures | Completed keyboard | Keyboard failures | Completed focus | Focus failures | Longest failure | Hung |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1 | 1,922 / 0 | 1 | 445,442 | 1 | 446,583 | 14,919 ms | yes |
| 2 | 1,922 / 0 | 0 | 429,700 | 0 | 430,643 | 15,015 ms | yes |

Run 1 began with `34,783,232` working-set bytes, `7,467,008` private bytes,
`390` handles, and `36` threads. Run 2 began with `35,147,776` working-set
bytes, `7,696,384` private bytes, `400` handles, and `41` threads. Every
posted message succeeded, while both windows failed the `WM_NULL` probe,
reported hung through `IsHungAppWindow`, and had
`Process.Responding == false`. Both Job snapshots contained 15 process
identities; each cleanup enabled kill-on-close, requested Job termination, used
no fallback, and verified zero Job or identity survivors. Both isolated
profiles were retained for diagnosis.

The controlled beta.3 dump has the same `WaitOnAddress -> reentrant mutex ->
SendMessageW -> PeekMessageW` stack as the production dump. The reentrant lock
return remains RVA `0x2b9cfd`; the outer keyboard-case return is RVA
`0x2b9361`.

## Fixed Release verification

The final fixed beta.6 Release was built from clean source commit
`a281585dabc0fd67aa7ce51e706dfdee3fc0675b` and ran the final harness for
three consecutive 15-second rounds beginning at
`2026-08-16T19:56:43.4746428+08:00`:

| Round | Posted / failures | Completed keyboard | Keyboard failures | Completed focus | Focus failures | Longest failure | Responsive |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1 | 1,924 / 0 | 97,065 | 0 | 181,522 | 0 | 0 ms | yes |
| 2 | 1,924 / 0 | 97,326 | 0 | 187,645 | 0 | 0 ms | yes |
| 3 | 1,916 / 0 | 97,500 | 0 | 185,688 | 0 | 0 ms | yes |
| **Total** | **5,764 / 0** | **291,891** | **0** | **554,855** | **0** | **0 ms** | **yes** |

The fixed process started at `37,367,808` working-set bytes, `7,757,824`
private bytes, `390` handles, and `36` threads. After round three it remained
responsive at `38,023,168` working-set bytes, `8,650,752` private bytes,
`407` handles, and `40` threads. Its Job snapshot contained 15
host/WebView/terminal identities. Cleanup enabled kill-on-close, requested Job
termination, used no fallback, verified zero Job and identity survivors,
closed the Job handle, removed the generated profile, and verified absence.

An additional two-second run used an explicitly supplied data-directory path
that contained spaces and ended in `\`. It accepted 258/258 posted messages,
completed `11,789` synchronous keyboard messages and `22,290` focus messages
with zero failures, created `data.db` at the exact supplied path, verified zero
process survivors, and removed the guarded test directory.

The Windows hook regression forces the client to connect, write, and close
before the server calls `ConnectNamedPipe`. It observes `ERROR_NO_DATA`
(`232`) and verifies that the complete buffered report reaches the sink.

## Independent review

Four agents independently reviewed the PR without conversation context.
Their actionable findings were resolved:

- unrelated lockfile churn was removed and Rust 1.88 was tested directly;
- the posted stream was paced and a maximum 10% post-failure gate was added;
- generated diagnostics are retained whenever stress or cleanup fails;
- process ancestry reconstruction was replaced with pre-resume Windows Job
  assignment and identity verification;
- dependency checks now validate Cargo metadata package IDs and resolved edges;
- cleanup enables kill-on-close before fallible queries, always attempts Job
  termination, records the root fallback, and closes the Job in `finally`;
- profile deletion occurs after Job-handle closure and requires zero cleanup
  errors;
- all stale Release measurements were replaced by runs from the final clean
  source commit.

The reporting reviewer rechecked the final code changes and found no remaining
concrete code issue. The final evidence records the current harness gates,
Rust 1.88 MSRV, source commit, and executable hash.

## Repository gates

- `pnpm format:check`: passed;
- `pnpm check`: Cargo metadata dependency edges, TypeScript, and the Rust
  workspace passed with the locked graph;
- `cargo +1.88.0 check --workspace --locked`: passed at the declared MSRV;
- `pnpm test`: 166 Rust tests and 290 frontend tests passed;
- `pnpm verify:version`: passed;
- `pnpm desktop:build:release`: passed and produced the fixed hash above;
- PowerShell parser, Job cleanup smoke, and already-exited-root cleanup:
  passed;
- beta.3 controls: 2/2 reproduced the same frozen-window state;
- fixed Release harness: 3/3 rounds passed every activity, response,
  post-quality, and cleanup gate;
- trailing-separator and spaced data-directory transport: passed;
- deterministic Windows pre-connect hook regression: passed.

Machine-readable measurements are in [`result.json`](result.json), and the
sanitized dump comparison is in
[`main-thread-stacks.txt`](main-thread-stacks.txt).
