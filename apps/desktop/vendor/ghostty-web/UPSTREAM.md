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
- render uncommitted IME preedit text as a cursor-aligned overlay and normalize
  committed `compositionend` or `input` text into one PTY write, including the
  `insertText`-only sequence emitted by Sogou on Windows WebView2.
- reset the existing WASM terminal with VT RIS instead of freeing/reallocating
  it, preventing uninitialized cells and stale SelectionManager references
  after Dockview-driven dimension changes.
- follow incoming output only while the viewport is already at the bottom;
  preserve a user-controlled history anchor across appended scrollback and
  continuous TUI thinking/status updates.
- temporarily enable DEC wraparound while resizing so a TUI that disables it
  cannot truncate primary-screen history instead of reflowing it.
- allow a validated application repaint to atomically replace screen and
  scrollback without resetting terminal input modes or replaying query replies.
- expose state-preserving full Canvas redraw and frame-copy APIs for native
  WebView restoration and atomic resize presentation.
- mirror Kitty keyboard and xterm modifyOtherKeys negotiation into the key
  encoder, preserve modified Enter, and honor DEC Alt escape-prefix mode.
- narrow nullable selection endpoints before destructuring so the vendored
  source passes the production TypeScript strict check without changing runtime behavior.
- reconstruct soft-wrapped logical lines for plain-text URL detection and map
  multi-row matches back to their terminal buffer cells.
- reconstruct styled Markdown URL/file continuations within their rendered
  columns, retaining exact clickable segments around indentation and table gaps.
- reconstruct default-style borderless Markdown table continuations from divider
  columns and row labels, preserving physical-cell hit ranges through soft wrapping.
- group the physical ranges of each URL/file occurrence for whole-link hover,
  redraw every segment on hover changes, and clip ranges at viewport boundaries.
- cache complete per-row link scans in provider priority order and coalesce
  concurrent requests; buffer changes invalidate pending scan generations.
- expose OSC 8 URIs by buffer position, assign page-stable hyperlink identities
  across Ghostty pages, and preserve the corresponding WASM source patch under
  `patches/ccsm-hyperlink-uri.patch`.
- pause the animation-frame render loop while a retained terminal is hidden,
  and redraw cursor/scrollback Canvas content only when presentation state
  changes instead of on every display refresh.
- round Canvas backing dimensions consistently at fractional display scaling,
  with the renderer owning both CSS and backing sizes to avoid idle reallocations.
- reuse each terminal's parsed viewport until the next write or resize;
  line reads remain independent copies and scrollback scratch-buffer reads
  do not invalidate the JavaScript snapshot.
- zero freshly allocated WASM page buffers during initial creation and growth,
  preserving existing terminal content while clearing recycled linear memory.
- flush Unicode generator stdout portably when building the WASM on Windows.

The checked-in WASM binary is rebuilt from the pinned source and
`ccsm-hyperlink-uri.patch` plus `ccsm-wasm-zero-pages.patch`; its SHA-256 is
`1ef1a10a1c4dfc7930382e7653e3f9d9a6259d0507e1ece5d6205ab0776dbe4e`.

To reproduce it, clone the pinned `coder/ghostty-web` commit, initialize its
Ghostty submodule, apply upstream `patches/ghostty-wasm-api.patch` inside that
submodule, then apply both CCSM patches and run with Zig 0.15.2:

```sh
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
```

Copy `ghostty/zig-out/bin/ghostty-vt.wasm` to this directory and verify the
SHA-256 above.

On Windows, place `ZIG_GLOBAL_CACHE_DIR` on the same volume as the checkout
so Zig's build runner can resolve relative paths for the Unicode generators.
