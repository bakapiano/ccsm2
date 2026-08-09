# ghostty-web local source pin

This directory pins `coder/ghostty-web` 0.4.0 at commit
`9e4e126d89ac3537d2b2ebec075849851566de9f` (MIT).

Local changes:

- skip Ghostty width-zero spacer cells when extracting selected text;
- draw U+2500..U+259F procedurally using the implementation from upstream
  pull request #164, preserving the original MIT license;
- request an opaque Canvas2D backing store when terminal transparency is off.
- calculate line height from full font bounds instead of a capital `M` ink box;
- treat a thresholded same-cell drag as a one-character selection;
- stabilize drag endpoints between rows with centre-line hysteresis.
- focus and position the hidden input textarea at the rendered cursor so
  Windows IME preedit and candidate UI use the terminal cursor as their anchor.
- render uncommitted IME preedit text as a cursor-aligned overlay and only send
  the committed `compositionend` payload to the PTY.
- reset the existing WASM terminal with VT RIS instead of freeing/reallocating
  it, preventing uninitialized cells and stale SelectionManager references
  after Dockview-driven dimension changes.
- follow incoming output only while the viewport is already at the bottom;
  preserve a user-controlled history anchor across appended scrollback and
  continuous TUI thinking/status updates.
- narrow nullable selection endpoints before destructuring so the vendored
  source passes the production TypeScript strict check without changing runtime behavior.

The checked-in WASM binary is the matching npm `ghostty-web@0.4.0` artifact.
