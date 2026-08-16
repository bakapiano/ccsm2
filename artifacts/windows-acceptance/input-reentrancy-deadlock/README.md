# Windows input reentrancy deadlock acceptance

## Result

PASS. The frozen `0.1.0-beta.3` Release executable was captured with full
host and WebView renderer dumps. Its native UI thread is deadlocked by a
reentrant Win32 input callback in Tao 0.35.3. The same deadlock was reproduced
with an isolated profile and a deterministic message-race harness. A Release
executable with the upstream Tao fix completed three identical 15-second
rounds while remaining responsive.

## Environment and binaries

- Windows x64, OS build `26200`;
- WinDbg `10.0.29617.1000`;
- frozen binary: `0.1.0-beta.3`, SHA-256
  `3516f28dab4c82cef1eedc0a1461f821e06637ba42439c0ba1ec401c3bede781`;
- fixed binary: `0.1.0-beta.5`, SHA-256
  `31494cf7f9ec3a4175de3af22bd77d8cc95d2aa635f5e6259612c0dd626802eb`.

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
locks. CCSM pins that commit while Tauri 2.11 remains on the Tao 0.35 line.

The pinned revision follows the `tao-v0.35.3` tag (`5a14e624`) by two commits.
Besides the Windows deadlock fix, its parent `47d38f36` adds four Linux JIS
key mappings in a six-line source delta. The exact ancestry is recorded here
because a Cargo git patch applies on every target. The locked Ubuntu workspace
CI passed with this revision.

## Deterministic reproduction

The regression harness starts CCSM with an isolated data directory, races
posted `WM_KEYDOWN`/`WM_KEYUP` messages against synchronous `WM_KILLFOCUS`, and
records every post/send failure with its Win32 error. Each round requires at
least 100 accepted keyboard messages, at least 10 completed focus messages, no
focus-send failure streak of 1,000 ms, a responsive `WM_NULL` probe, a clear
`IsHungAppWindow` result, and `Process.Responding`:

```powershell
pwsh -File scripts/windows-input-deadlock-repro.ps1 `
  -Executable <release-executable> -Seconds 15 -Rounds 1
```

Generated profiles are removed after successful runs. Failed runs retain their
profile for diagnosis; `-KeepProcess` preserves the tested process tree for a
dump, and `-KeepData` preserves a successful run's generated profile.

Fresh beta.3 result (`2026-08-16T09:36:32.6970078+08:00`):

- keyboard post attempts: `3,051,310`;
- accepted keyboard messages: `10,000`;
- keyboard post failures: `3,041,310`, last error `1816`
  (`ERROR_NOT_ENOUGH_QUOTA`) after the UI queue stopped draining;
- completed focus messages: `0`;
- failed focus sends: `317,502` (`81` `ERROR_TIMEOUT` results and `317,421`
  immediate `SMTO_ABORTIFHUNG` results);
- longest continuous focus-send failure: `15,009 ms`;
- final window probe responsive: `false`;
- `IsHungAppWindow`: `true`;
- final process responding: `false`.

The previous harness called every zero `SendMessageTimeoutW` result a timeout.
The reviewed harness clears and reads `LastError` on every call and checks
`IsHungAppWindow`, so the counters above preserve the Win32 distinction.

Its controlled dump has the same `WaitOnAddress -> reentrant mutex ->
SendMessageW -> PeekMessageW` stack as the production dump. The reentrant lock
return remains RVA `0x2b9cfd`; the outer keyboard-case return is RVA
`0x2b9361`.

## Fixed Release verification

The final fixed beta.5 Release executable ran the reviewed harness for three
consecutive 15-second rounds starting at
`2026-08-16T09:41:53.3452311+08:00`:

| Round | Keyboard messages | Completed focus messages | Focus failures | Longest failure | Responsive |
| ---: | ---: | ---: | ---: | ---: | :---: |
| 1 | 40,712 | 59,750 | 0 | 0 ms | yes |
| 2 | 31,792 | 60,917 | 0 | 0 ms | yes |
| 3 | 31,212 | 61,348 | 0 | 0 ms | yes |
| **Total** | **103,716** | **182,015** | **0** | **0 ms** | **yes** |

The fixed process started at `32,817,152` working-set bytes, `7,843,840`
private bytes, `408` handles, and `41` threads. After round three it remained
responsive at `49,963,008` working-set bytes, `30,830,592` private bytes,
`417` handles, and `40` threads. The harness then killed and waited for its
owned process tree, removed its generated profile, and found zero remaining
host or WebView processes from that run.

The Windows hook regression now forces the client to connect, write, and close
before the server calls `ConnectNamedPipe`. It observes `ERROR_NO_DATA` (`232`)
and verifies that the complete buffered report reaches the sink.

## Repository gates

- `pnpm format:check`: passed;
- `pnpm check`: TypeScript and Rust workspace checks passed with the locked
  dependency graph;
- `pnpm test`: `166` Rust tests and `288` frontend tests passed;
- `pnpm desktop:build:release`: passed and produced the fixed binary hash
  recorded above;
- fixed Release deadlock harness: three rounds passed with zero focus-send
  failures and every activity/response gate satisfied;
- deterministic Windows pre-connect hook regression: passed.

Machine-readable measurements are in [`result.json`](result.json), and the
sanitized dump comparison is in
[`main-thread-stacks.txt`](main-thread-stacks.txt).
