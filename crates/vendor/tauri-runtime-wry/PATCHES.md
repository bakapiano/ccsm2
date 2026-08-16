# CCSM Tauri runtime integration

This directory starts from the crates.io `tauri-runtime-wry` `2.11.4`
package (registry checksum
`4e6fac707727b7a2f48e4ded90976324267371073edbb415ffb73bb0458d203f`).
CCSM applies the runtime adapter changes from Tauri commit
[`7cc68e74`](https://github.com/tauri-apps/tauri/commit/7cc68e74ff6981f5c50a52a67d56c5eb2d227188),
`feat: update tao to 0.36 and wry to 0.56 (#15307)`.

The local delta is limited to:

- Tao `0.35` to `0.36` and Wry `0.55` to `0.56` dependency integration;
- the corresponding Tao window-event mapping changes in `src/lib.rs`;
- removal of Wry features retired by Wry `0.56`;
- the `objc2-app-kit` constraint used by the upstream integration; and
- Rust `1.90`, matching the upstream Tauri workspace at that revision.

The package retains the upstream Apache-2.0 and MIT license files. Once Tauri
publishes a compatible runtime, remove this directory and the root Cargo patch
after the Windows deadlock acceptance harness passes against that release.
