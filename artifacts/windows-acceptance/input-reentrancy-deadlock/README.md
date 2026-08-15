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
  `19823f679ee95752f3999ef167d4a04c89d18ed5c753c3705996dd3d381e943b`.

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
   processing a keyboard-related window message.
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

## Deterministic reproduction

The regression harness starts CCSM with an isolated data directory, races
posted `WM_KEYDOWN`/`WM_KEYUP` messages against synchronous `WM_KILLFOCUS`, and
then checks both a `WM_NULL` timeout probe and `Process.Responding`:

```powershell
pwsh -File scripts/windows-input-deadlock-repro.ps1 `
  -Executable <release-executable> -Seconds 15 -Rounds 1
```

Fresh beta.3 result:

- posted keyboard messages: `10,000`;
- completed focus messages: `0`;
- focus-message timeouts: `593,757`;
- final window probe responsive: `false`;
- final process responding: `false`.

Its controlled dump has the same `WaitOnAddress -> reentrant mutex ->
SendMessageW -> PeekMessageW` stack as the production dump. The reentrant lock
return remains RVA `0x2b9cfd`; the outer keyboard-case return is RVA
`0x2b9361`.

## Fixed Release verification

The fixed beta.5 Release executable ran the same harness for three consecutive
15-second rounds:

| Round | Keyboard messages | Completed focus messages | Timeouts | Responsive |
| ---: | ---: | ---: | ---: | :---: |
| 1 | 37,349 | 54,970 | 0 | yes |
| 2 | 28,284 | 55,148 | 0 | yes |
| 3 | 27,784 | 54,710 | 0 | yes |
| **Total** | **93,417** | **164,828** | **0** | **yes** |

The fixed process started at `29,958,144` working-set bytes, `6,918,144`
private bytes, `354` handles, and `36` threads. After round three it remained
responsive at `45,174,784` working-set bytes, `30,109,696` private bytes,
`361` handles, and `35` threads.

## Repository gates

- `pnpm format:check`: passed;
- `pnpm check`: TypeScript and Rust workspace checks passed with the locked
  dependency graph;
- `pnpm test`: `165` Rust tests and `288` frontend tests passed;
- `pnpm desktop:build:release`: passed and produced the fixed binary hash
  recorded above;
- fixed Release deadlock harness: three rounds passed with zero timeouts.

Machine-readable measurements are in [`result.json`](result.json), and the
sanitized dump comparison is in
[`main-thread-stacks.txt`](main-thread-stacks.txt).
