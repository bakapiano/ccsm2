# Vendored Windows terminal components

- `portable-pty/` is portable-pty 0.9.0 (MIT), including Herdr's Apache-2.0
  hash-verified app-local ConPTY loader adaptation. The original MIT license is
  retained in `portable-pty/LICENSE.md`; Herdr's license and patch notes are
  retained beside this file.
- `conpty/` is Microsoft.Windows.Console.ConPTY 1.24.260710001 (MIT), copied
  from the hash-pinned Herdr Windows distribution. Its manifest contains the
  expected SHA-256 values.
- `conpty-notices/` retains Microsoft's license and third-party notices.

The app-local runtime is required for semantic correctness: the system ConPTY
on this test host flattens top-anchored DEC scroll-region history into viewport
repaints, while the pinned runtime preserves the history-producing VT stream.
