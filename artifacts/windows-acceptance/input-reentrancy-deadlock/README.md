# Windows input reentrancy deadlock acceptance

## Result

PASS. The frozen `0.1.0-beta.3` Release executable was captured with full
host and WebView renderer dumps. Its native UI thread is deadlocked by a
reentrant Win32 input callback in Tao 0.35.3. The same deadlock was reproduced
with an isolated profile and a deterministic message-race harness. A Release
executable using the published Tao 0.36.0 fix completed three identical
15-second rounds while remaining responsive.

## Environment and binaries

- Windows x64, OS build `26200`;
- WinDbg `10.0.29617.1000`;
- frozen binary: `0.1.0-beta.3`, SHA-256
  `3516f28dab4c82cef1eedc0a1461f821e06637ba42439c0ba1ec401c3bede781`;
- fixed binary: `0.1.0-beta.6`, SHA-256
  `dfe1e15651819590f7cedb0f9539e934a78708dcb92e6e65edb966d4321c0ea0`,
  built from clean source commit
  `189848788c7ab3c7b8b4efcee507090b2f532e8c`.

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

Tauri `2.11.5`, JavaScript API `2.11.1`, and CLI `2.11.4` are the latest
stable releases at verification time. The published `tauri-runtime-wry`
`2.11.4` still constrains Tao to `^0.35.0`, so CCSM applies Tauri's merged
[`7cc68e74`](https://github.com/tauri-apps/tauri/commit/7cc68e74ff6981f5c50a52a67d56c5eb2d227188)
Tao 0.36/Wry 0.56 adapter delta to a vendored copy of the published runtime.
The vendored base has crates.io checksum
`4e6fac707727b7a2f48e4ded90976324267371073edbb415ffb73bb0458d203f`.
Released `tauri-runtime` `2.11.3` and `tauri-utils` `2.9.3` stay on crates.io;
the locked graph resolves Tao `0.36.0` and Wry `0.56.1` from crates.io. The
workspace MSRV is Rust `1.90`, matching the upstream integration revision.

## Deterministic reproduction

The regression harness starts CCSM with an isolated data directory and races
three independent streams: posted `WM_KEYDOWN`/`WM_KEYUP`, synchronous
`WM_KEYDOWN`/`WM_KEYUP`, and synchronous `WM_KILLFOCUS`. The synchronous
keyboard stream proves that the target WndProc actually executed keyboard
handling; enqueue success alone is only a queue observation. Each round
requires at least 100 accepted posted keyboard messages, at least 100 completed
synchronous keyboard messages, at least 10 completed focus messages, failure
streaks below 1,000 ms, a responsive `WM_NULL` probe, a clear
`IsHungAppWindow` result, and `Process.Responding`:

```powershell
pwsh -File scripts/windows-input-deadlock-repro.ps1 `
  -Executable <release-executable> -Seconds 15 -Rounds 1
```

The harness emits its result after cleanup. It snapshots the full owned tree
before termination, records each PID with its UTC creation-time ticks, kills
and awaits the tree, and verifies every captured identity is gone. Successful
generated profiles are removed and verified absent. Failed runs retain their
profile for diagnosis. `-KeepProcess` preserves the tested process tree for a
dump, and `-KeepData` preserves a successful run's generated profile.

Two fresh beta.3 control runs independently reproduced the freeze:

| Run | Completed keyboard | Keyboard failures | Completed focus | Focus failures | Longest failure | Hung |
| ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1 | 0 | 212,765 | 0 | 212,818 | 15,005 ms | yes |
| 2 | 0 | 210,577 | 0 | 210,597 | 15,007 ms | yes |

Run 1 began with `32,944,128` working-set bytes, `7,761,920` private bytes,
`385` handles, and `41` threads. Run 2 began with `32,890,880` working-set
bytes, `8,261,632` private bytes, `385` handles, and `41` threads. The runs
accepted `10,000` and `9,999` posted keyboard messages before the dead UI
queue filled and `PostMessageW` returned `ERROR_NOT_ENOUGH_QUOTA` (`1816`).
Both windows failed the `WM_NULL` probe, reported hung through
`IsHungAppWindow`, and had `Process.Responding == false`. Each pre-termination
snapshot contained 15 host/WebView/terminal process identities; verification
by PID plus creation time found zero survivors. Both isolated profiles were
retained for diagnosis.

The harness clears and reads `LastError` on every synchronous call and checks
`IsHungAppWindow`, preserving the distinction between `ERROR_TIMEOUT` and
immediate `SMTO_ABORTIFHUNG` results.

Its controlled dump has the same `WaitOnAddress -> reentrant mutex ->
SendMessageW -> PeekMessageW` stack as the production dump. The reentrant lock
return remains RVA `0x2b9cfd`; the outer keyboard-case return is RVA
`0x2b9361`.

## Fixed Release verification

The final fixed beta.6 Release executable (`6,002,176` bytes) was built from
clean source commit `189848788c7ab3c7b8b4efcee507090b2f532e8c` and ran the
reviewed harness for three consecutive 15-second rounds starting at
`2026-08-16T11:57:13.6180864+08:00`:

| Round | Completed keyboard | Keyboard failures | Completed focus | Focus failures | Longest failure | Responsive |
| ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1 | 31,399 | 0 | 62,770 | 0 | 0 ms | yes |
| 2 | 31,023 | 0 | 62,018 | 0 | 0 ms | yes |
| 3 | 31,623 | 0 | 63,215 | 0 | 0 ms | yes |
| **Total** | **94,045** | **0** | **188,003** | **0** | **0 ms** | **yes** |

The fixed process started at `33,292,288` working-set bytes, `8,646,656`
private bytes, `385` handles, and `42` threads. After round three it remained
responsive at `54,550,528` working-set bytes, `30,724,096` private bytes,
`395` handles, and `40` threads. The harness then terminated and waited for
its owned process tree. Its pre-termination snapshot contained 15 process
identities; verification by PID plus creation time found zero survivors. The
harness removed its generated profile and verified the directory absent.

An additional two-second run passed with an explicitly supplied data-directory
argument ending in `\`. It completed `4,320` synchronous keyboard messages and
`8,561` focus messages with zero failures. `data.db` was created at the exact
supplied path, the process tree was verified empty, and the test directory was
removed after a guarded path check.

The Windows hook regression now forces the client to connect, write, and close
before the server calls `ConnectNamedPipe`. It observes `ERROR_NO_DATA` (`232`)
and verifies that the complete buffered report reaches the sink.

## Repository gates

- `pnpm format:check`: passed;
- `pnpm check`: the exact Tauri/Tao/Wry dependency assertion, TypeScript, and
  Rust workspace checks passed with the locked dependency graph;
- `cargo +1.90.0 check --workspace --locked`: passed at the declared MSRV;
- `pnpm test`: `166` Rust tests and `288` frontend tests passed;
- `pnpm desktop:build:release`: passed and produced the fixed binary hash
  recorded above;
- two beta.3 control runs: both reproduced the freeze with zero completed
  synchronous keyboard or focus messages;
- fixed Release deadlock harness: three rounds passed with zero synchronous
  keyboard/focus failures and every activity, response, and cleanup gate
  satisfied;
- deterministic Windows pre-connect hook regression: passed.

Machine-readable measurements are in [`result.json`](result.json), and the
sanitized dump comparison is in
[`main-thread-stacks.txt`](main-thread-stacks.txt).
