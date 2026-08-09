/**
 * Box-drawing and Block-element renderer (U+2500..U+259F).
 *
 * Glyphs in this range are designed to tile seamlessly across cells.
 * Letting the font render them is fragile:
 *   - The font's advance width may not match our cell width exactly,
 *     leaving gaps (or overlaps) between adjacent box-drawing chars.
 *   - The font's chosen ascent/descent for these glyphs rarely matches
 *     the cell height we need for descender-safe text rendering, so
 *     vertical lines and full blocks leave gaps between rows.
 *   - Different fonts encode these glyphs with different proportions, so
 *     visual consistency is poor.
 *
 * We draw them as canvas paths sized to the cell instead. This is the
 * standard fix — Alacritty, kitty, wezterm, Ghostty native, and Windows
 * Terminal all do this. The implementation here ports Ghostty's
 * `box.zig` (U+2500..U+257F) and `block.zig` (U+2580..U+259F) into
 * Canvas2D, including:
 *   - junction-aware arm endpoints for clean weighted T-junctions and
 *     double-line corners (`drawEdges`),
 *   - cubic-Bezier arcs that join flush to straight neighbors (`drawArc`),
 *   - axis-asymmetric dashed-line layout that tiles across cells
 *     (`drawDashed`),
 *   - sub-pixel diagonal overshoot for clean tiling under anti-aliasing
 *     (`drawDiagonal`),
 *   - a `block(alignment, wFrac, hFrac)` / `quadrant({tl,tr,bl,br})`
 *     pair for the U+2580..U+259F family.
 */

// ============================================================================
// Common types
// ============================================================================

// Edge weight: none, light (single thin line), heavy (single thick line),
// or double (two parallel thin lines with a 1-light gap between them).
type Weight = 0 | 1 | 2 | 3;
const N: Weight = 0;
const L: Weight = 1;
const H: Weight = 2;
const D: Weight = 3;

function heavyThickness(lightPx: number): number {
  return lightPx * 2;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Returns true if the codepoint is a box-drawing or block-element glyph
 * that we render directly. Caller should skip the font path in that case.
 */
export function isBoxOrBlock(codepoint: number): boolean {
  return codepoint >= 0x2500 && codepoint <= 0x259f;
}

/**
 * Render a box-drawing or block-element glyph into the cell at (x, y, w, h).
 *
 *   - `color` is the css color string used for the foreground stroke/fill.
 *   - `lightPx` is the font-derived light box-stroke thickness in CSS
 *     pixels (heavy is 2× this; double is two parallels separated by
 *     one light gap, totaling 3× this). Use the `boxThickness` value
 *     measured in `CanvasRenderer.measureFont`. Defensively rounded
 *     to the nearest integer ≥ 1 inside this function — fractional
 *     values produce sub-pixel dash positions that don't tile across
 *     adjacent cells, so the API silently normalizes.
 *
 * Returns true if the glyph was handled; false if the caller should
 * fall back to font rendering. Returns false (no draw) if `w` or `h`
 * is non-positive, since a zero-area cell can't contain visible
 * geometry and would feed `0/0 = NaN` into the arc slope math.
 */
export function drawBoxOrBlock(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  lightPx: number
): boolean {
  // Defensive clamps for arbitrary public-API callers. The built-in
  // renderer always passes positive `w`/`h` and an integer `lightPx`,
  // but a public consumer might not. A 0×0 cell would feed NaN
  // (0/0) into `drawArc`'s slope math; a fractional lightPx would
  // produce sub-pixel dash positions that don't tile.
  if (!(w > 0) || !(h > 0)) return false;
  const px = Math.max(1, Math.round(lightPx));

  if (codepoint >= 0x2580 && codepoint <= 0x259f) {
    return drawBlockElement(ctx, codepoint, x, y, w, h, color);
  }
  if (codepoint >= 0x2500 && codepoint <= 0x257f) {
    return drawBoxLine(ctx, codepoint, x, y, w, h, color, px);
  }
  return false;
}

// ============================================================================
// Block elements (U+2580..U+259F)
//
// Ports the structure of Ghostty's `block.zig`: named fraction constants
// (`block.zig:19-28`), a generic `block(alignment, wFrac, hFrac)` helper
// (`block.zig:111-152`), a `quadrant({tl,tr,bl,br})` helper for the
// multi-corner combinations (`block.zig:168-177`), and a shade helper
// for ░▒▓. Ghostty bakes alpha levels of 0x40 / 0x80 / 0xc0 into its
// sprite atlas (`common.zig:42-51`), i.e. 0.251 / 0.502 / 0.753; we
// use 0.25 / 0.5 / 0.75, which differs by under 0.003 — visually
// indistinguishable but worth noting.
// ============================================================================

// Named fractions, matching block.zig:19-28.
const ONE_EIGHTH = 1 / 8;
const ONE_QUARTER = 1 / 4;
const THREE_EIGHTHS = 3 / 8;
const HALF = 1 / 2;
const FIVE_EIGHTHS = 5 / 8;
const THREE_QUARTERS = 3 / 4;
const SEVEN_EIGHTHS = 7 / 8;

/**
 * Where in the cell to anchor a partial-cell `block`.
 *   - `'upper'`: full width, anchored to the cell top.
 *   - `'lower'`: full width, anchored to the cell bottom.
 *   - `'left'`:  full height, anchored to the cell left.
 *   - `'right'`: full height, anchored to the cell right.
 *
 * Mirrors Ghostty's `Alignment` named constants (`common.zig:92-95`).
 */
type Alignment = 'upper' | 'lower' | 'left' | 'right';

interface Quads {
  tl?: boolean;
  tr?: boolean;
  bl?: boolean;
  br?: boolean;
}

/**
 * Fill a fractional sub-rectangle of the cell, anchored per `alignment`.
 * Sizes are given as fractions of the cell so the same call shape works
 * for halves, eighths, and full-cell rendering.
 */
function block(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  cw: number,
  ch: number,
  color: string,
  alignment: Alignment,
  wFrac: number,
  hFrac: number
): void {
  const w = cw * wFrac;
  const h = ch * hFrac;
  let dx = 0;
  let dy = 0;
  switch (alignment) {
    case 'upper':
      dx = (cw - w) / 2;
      dy = 0;
      break;
    case 'lower':
      dx = (cw - w) / 2;
      dy = ch - h;
      break;
    case 'left':
      dx = 0;
      dy = (ch - h) / 2;
      break;
    case 'right':
      dx = cw - w;
      dy = (ch - h) / 2;
      break;
  }
  ctx.fillStyle = color;
  ctx.fillRect(ox + dx, oy + dy, w, h);
}

/**
 * Fill any subset of the cell's four 2x2 quadrants. Ports Ghostty's
 * `quadrant` (`block.zig:168-177`) for the ▖▗▘▙▚▛▜▝▞▟ family.
 */
function quadrant(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  q: Quads
): void {
  ctx.fillStyle = color;
  const hw = w / 2;
  const hh = h / 2;
  if (q.tl) ctx.fillRect(x, y, hw, hh);
  if (q.tr) ctx.fillRect(x + hw, y, hw, hh);
  if (q.bl) ctx.fillRect(x, y + hh, hw, hh);
  if (q.br) ctx.fillRect(x + hw, y + hh, hw, hh);
}

/**
 * Fill the entire cell at a fractional opacity. Used for ░▒▓.
 */
function fullShade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha: number
): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function drawBlockElement(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): boolean {
  switch (cp) {
    // ▀▄▌▐ — halves.
    case 0x2580: // ▀ upper half
      block(ctx, x, y, w, h, color, 'upper', 1, HALF);
      return true;
    case 0x2584: // ▄ lower half
      block(ctx, x, y, w, h, color, 'lower', 1, HALF);
      return true;
    case 0x258c: // ▌ left half
      block(ctx, x, y, w, h, color, 'left', HALF, 1);
      return true;
    case 0x2590: // ▐ right half
      block(ctx, x, y, w, h, color, 'right', HALF, 1);
      return true;

    // ▔▕ — top and right one-eighth strokes.
    case 0x2594: // ▔ upper 1/8
      block(ctx, x, y, w, h, color, 'upper', 1, ONE_EIGHTH);
      return true;
    case 0x2595: // ▕ right 1/8
      block(ctx, x, y, w, h, color, 'right', ONE_EIGHTH, 1);
      return true;

    // ▁▂▃▅▆▇ — lower-eighths family. Each fills the bottom n/8 of the cell.
    case 0x2581: // ▁ lower 1/8
      block(ctx, x, y, w, h, color, 'lower', 1, ONE_EIGHTH);
      return true;
    case 0x2582: // ▂ lower 2/8
      block(ctx, x, y, w, h, color, 'lower', 1, ONE_QUARTER);
      return true;
    case 0x2583: // ▃ lower 3/8
      block(ctx, x, y, w, h, color, 'lower', 1, THREE_EIGHTHS);
      return true;
    case 0x2585: // ▅ lower 5/8
      block(ctx, x, y, w, h, color, 'lower', 1, FIVE_EIGHTHS);
      return true;
    case 0x2586: // ▆ lower 6/8
      block(ctx, x, y, w, h, color, 'lower', 1, THREE_QUARTERS);
      return true;
    case 0x2587: // ▇ lower 7/8
      block(ctx, x, y, w, h, color, 'lower', 1, SEVEN_EIGHTHS);
      return true;

    // █ full block.
    case 0x2588:
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      return true;

    // ▉▊▋▍▎▏ — left-eighths family. Each fills the left n/8 of the cell.
    case 0x2589: // ▉ left 7/8
      block(ctx, x, y, w, h, color, 'left', SEVEN_EIGHTHS, 1);
      return true;
    case 0x258a: // ▊ left 6/8
      block(ctx, x, y, w, h, color, 'left', THREE_QUARTERS, 1);
      return true;
    case 0x258b: // ▋ left 5/8
      block(ctx, x, y, w, h, color, 'left', FIVE_EIGHTHS, 1);
      return true;
    case 0x258d: // ▍ left 3/8
      block(ctx, x, y, w, h, color, 'left', THREE_EIGHTHS, 1);
      return true;
    case 0x258e: // ▎ left 2/8
      block(ctx, x, y, w, h, color, 'left', ONE_QUARTER, 1);
      return true;
    case 0x258f: // ▏ left 1/8
      block(ctx, x, y, w, h, color, 'left', ONE_EIGHTH, 1);
      return true;

    // ░▒▓ — shades.
    case 0x2591: // ░ light shade
      fullShade(ctx, x, y, w, h, color, 0.25);
      return true;
    case 0x2592: // ▒ medium shade
      fullShade(ctx, x, y, w, h, color, 0.5);
      return true;
    case 0x2593: // ▓ dark shade
      fullShade(ctx, x, y, w, h, color, 0.75);
      return true;

    // ▖▗▘▝ — single-quadrant blocks.
    case 0x2596: // ▖ lower-left
      quadrant(ctx, x, y, w, h, color, { bl: true });
      return true;
    case 0x2597: // ▗ lower-right
      quadrant(ctx, x, y, w, h, color, { br: true });
      return true;
    case 0x2598: // ▘ upper-left
      quadrant(ctx, x, y, w, h, color, { tl: true });
      return true;
    case 0x259d: // ▝ upper-right
      quadrant(ctx, x, y, w, h, color, { tr: true });
      return true;

    // ▙▚▛▜▞▟ — multi-quadrant combinations.
    case 0x2599: // ▙
      quadrant(ctx, x, y, w, h, color, { tl: true, bl: true, br: true });
      return true;
    case 0x259a: // ▚
      quadrant(ctx, x, y, w, h, color, { tl: true, br: true });
      return true;
    case 0x259b: // ▛
      quadrant(ctx, x, y, w, h, color, { tl: true, tr: true, bl: true });
      return true;
    case 0x259c: // ▜
      quadrant(ctx, x, y, w, h, color, { tl: true, tr: true, br: true });
      return true;
    case 0x259e: // ▞
      quadrant(ctx, x, y, w, h, color, { tr: true, bl: true });
      return true;
    case 0x259f: // ▟
      quadrant(ctx, x, y, w, h, color, { tr: true, bl: true, br: true });
      return true;
  }
  return false;
}

// ============================================================================
// Box-drawing lines (U+2500..U+257F)
//
// Four sub-families:
//   - Orthogonal lines, corners, T-junctions, crosses, stubs, and double
//     variants — described by directional weights in the EDGES table and
//     drawn by `drawEdges`.
//   - Quarter-circle arcs (╭╮╯╰) — drawn as cubic Bezier curves so they
//     join cleanly to neighboring straight cells.
//   - Dashed/dotted horizontal & vertical lines — drawn with integer-
//     pixel gap distribution that tiles cleanly across cells.
//   - Diagonals (╱╲╳) — drawn with sub-pixel overshoot so the diagonal
//     reaches the cell corner exactly under anti-aliasing.
//
// Ports the algorithm from Ghostty native's `box.zig:linesChar`. The
// junction-aware arm endpoints (`up_bottom`, `down_top`, `left_right`,
// `right_left`) are what make weighted corners and T-junctions look
// correct: a heavy crossbar fully covers a light arm, a double-line
// corner forms a clean inner "L" instead of two crossing parallels, etc.
// ============================================================================

interface Edges {
  l: Weight;
  r: Weight;
  u: Weight;
  d: Weight;
}

// Codepoint → directional weights for the orthogonal box-drawing glyphs.
// biome-ignore format: aligned table is more readable than reflowed
const EDGES = new Map<number, Edges>([
  [0x2500, { l: L, r: L, u: N, d: N }], // ─
  [0x2501, { l: H, r: H, u: N, d: N }], // ━
  [0x2502, { l: N, r: N, u: L, d: L }], // │
  [0x2503, { l: N, r: N, u: H, d: H }], // ┃
  [0x250c, { l: N, r: L, u: N, d: L }], // ┌
  [0x250d, { l: N, r: H, u: N, d: L }], // ┍
  [0x250e, { l: N, r: L, u: N, d: H }], // ┎
  [0x250f, { l: N, r: H, u: N, d: H }], // ┏
  [0x2510, { l: L, r: N, u: N, d: L }], // ┐
  [0x2511, { l: H, r: N, u: N, d: L }], // ┑
  [0x2512, { l: L, r: N, u: N, d: H }], // ┒
  [0x2513, { l: H, r: N, u: N, d: H }], // ┓
  [0x2514, { l: N, r: L, u: L, d: N }], // └
  [0x2515, { l: N, r: H, u: L, d: N }], // ┕
  [0x2516, { l: N, r: L, u: H, d: N }], // ┖
  [0x2517, { l: N, r: H, u: H, d: N }], // ┗
  [0x2518, { l: L, r: N, u: L, d: N }], // ┘
  [0x2519, { l: H, r: N, u: L, d: N }], // ┙
  [0x251a, { l: L, r: N, u: H, d: N }], // ┚
  [0x251b, { l: H, r: N, u: H, d: N }], // ┛
  [0x251c, { l: N, r: L, u: L, d: L }], // ├
  [0x251d, { l: N, r: H, u: L, d: L }], // ┝
  [0x251e, { l: N, r: L, u: H, d: L }], // ┞
  [0x251f, { l: N, r: L, u: L, d: H }], // ┟
  [0x2520, { l: N, r: L, u: H, d: H }], // ┠
  [0x2521, { l: N, r: H, u: H, d: L }], // ┡
  [0x2522, { l: N, r: H, u: L, d: H }], // ┢
  [0x2523, { l: N, r: H, u: H, d: H }], // ┣
  [0x2524, { l: L, r: N, u: L, d: L }], // ┤
  [0x2525, { l: H, r: N, u: L, d: L }], // ┥
  [0x2526, { l: L, r: N, u: H, d: L }], // ┦
  [0x2527, { l: L, r: N, u: L, d: H }], // ┧
  [0x2528, { l: L, r: N, u: H, d: H }], // ┨
  [0x2529, { l: H, r: N, u: H, d: L }], // ┩
  [0x252a, { l: H, r: N, u: L, d: H }], // ┪
  [0x252b, { l: H, r: N, u: H, d: H }], // ┫
  [0x252c, { l: L, r: L, u: N, d: L }], // ┬
  [0x252d, { l: H, r: L, u: N, d: L }], // ┭
  [0x252e, { l: L, r: H, u: N, d: L }], // ┮
  [0x252f, { l: H, r: H, u: N, d: L }], // ┯
  [0x2530, { l: L, r: L, u: N, d: H }], // ┰
  [0x2531, { l: H, r: L, u: N, d: H }], // ┱
  [0x2532, { l: L, r: H, u: N, d: H }], // ┲
  [0x2533, { l: H, r: H, u: N, d: H }], // ┳
  [0x2534, { l: L, r: L, u: L, d: N }], // ┴
  [0x2535, { l: H, r: L, u: L, d: N }], // ┵
  [0x2536, { l: L, r: H, u: L, d: N }], // ┶
  [0x2537, { l: H, r: H, u: L, d: N }], // ┷
  [0x2538, { l: L, r: L, u: H, d: N }], // ┸
  [0x2539, { l: H, r: L, u: H, d: N }], // ┹
  [0x253a, { l: L, r: H, u: H, d: N }], // ┺
  [0x253b, { l: H, r: H, u: H, d: N }], // ┻
  [0x253c, { l: L, r: L, u: L, d: L }], // ┼
  [0x253d, { l: H, r: L, u: L, d: L }], // ┽
  [0x253e, { l: L, r: H, u: L, d: L }], // ┾
  [0x253f, { l: H, r: H, u: L, d: L }], // ┿
  [0x2540, { l: L, r: L, u: H, d: L }], // ╀
  [0x2541, { l: L, r: L, u: L, d: H }], // ╁
  [0x2542, { l: L, r: L, u: H, d: H }], // ╂
  [0x2543, { l: H, r: L, u: H, d: L }], // ╃
  [0x2544, { l: L, r: H, u: H, d: L }], // ╄
  [0x2545, { l: H, r: L, u: L, d: H }], // ╅
  [0x2546, { l: L, r: H, u: L, d: H }], // ╆
  [0x2547, { l: H, r: H, u: H, d: L }], // ╇
  [0x2548, { l: H, r: H, u: L, d: H }], // ╈
  [0x2549, { l: H, r: L, u: H, d: H }], // ╉
  [0x254a, { l: L, r: H, u: H, d: H }], // ╊
  [0x254b, { l: H, r: H, u: H, d: H }], // ╋
  [0x2550, { l: D, r: D, u: N, d: N }], // ═
  [0x2551, { l: N, r: N, u: D, d: D }], // ║
  [0x2552, { l: N, r: D, u: N, d: L }], // ╒
  [0x2553, { l: N, r: L, u: N, d: D }], // ╓
  [0x2554, { l: N, r: D, u: N, d: D }], // ╔
  [0x2555, { l: D, r: N, u: N, d: L }], // ╕
  [0x2556, { l: L, r: N, u: N, d: D }], // ╖
  [0x2557, { l: D, r: N, u: N, d: D }], // ╗
  [0x2558, { l: N, r: D, u: L, d: N }], // ╘
  [0x2559, { l: N, r: L, u: D, d: N }], // ╙
  [0x255a, { l: N, r: D, u: D, d: N }], // ╚
  [0x255b, { l: D, r: N, u: L, d: N }], // ╛
  [0x255c, { l: L, r: N, u: D, d: N }], // ╜
  [0x255d, { l: D, r: N, u: D, d: N }], // ╝
  [0x255e, { l: N, r: D, u: L, d: L }], // ╞
  [0x255f, { l: N, r: L, u: D, d: D }], // ╟
  [0x2560, { l: N, r: D, u: D, d: D }], // ╠
  [0x2561, { l: D, r: N, u: L, d: L }], // ╡
  [0x2562, { l: L, r: N, u: D, d: D }], // ╢
  [0x2563, { l: D, r: N, u: D, d: D }], // ╣
  [0x2564, { l: D, r: D, u: N, d: L }], // ╤
  [0x2565, { l: L, r: L, u: N, d: D }], // ╥
  [0x2566, { l: D, r: D, u: N, d: D }], // ╦
  [0x2567, { l: D, r: D, u: L, d: N }], // ╧
  [0x2568, { l: L, r: L, u: D, d: N }], // ╨
  [0x2569, { l: D, r: D, u: D, d: N }], // ╩
  [0x256a, { l: D, r: D, u: L, d: L }], // ╪
  [0x256b, { l: L, r: L, u: D, d: D }], // ╫
  [0x256c, { l: D, r: D, u: D, d: D }], // ╬
  [0x2574, { l: L, r: N, u: N, d: N }], // ╴
  [0x2575, { l: N, r: N, u: L, d: N }], // ╵
  [0x2576, { l: N, r: L, u: N, d: N }], // ╶
  [0x2577, { l: N, r: N, u: N, d: L }], // ╷
  [0x2578, { l: H, r: N, u: N, d: N }], // ╸
  [0x2579, { l: N, r: N, u: H, d: N }], // ╹
  [0x257a, { l: N, r: H, u: N, d: N }], // ╺
  [0x257b, { l: N, r: N, u: N, d: H }], // ╻
  [0x257c, { l: L, r: H, u: N, d: N }], // ╼
  [0x257d, { l: N, r: N, u: L, d: H }], // ╽
  [0x257e, { l: H, r: L, u: N, d: N }], // ╾
  [0x257f, { l: N, r: N, u: H, d: L }], // ╿
]);

// Dashed lines: number of dashes per stroke, weight, and orientation.
interface Dashed {
  count: 2 | 3 | 4;
  weight: Weight;
  vertical: boolean;
}

// biome-ignore format: aligned table
const DASHED = new Map<number, Dashed>([
  [0x2504, { count: 3, weight: L, vertical: false }], // ┄
  [0x2505, { count: 3, weight: H, vertical: false }], // ┅
  [0x2506, { count: 3, weight: L, vertical: true }], // ┆
  [0x2507, { count: 3, weight: H, vertical: true }], // ┇
  [0x2508, { count: 4, weight: L, vertical: false }], // ┈
  [0x2509, { count: 4, weight: H, vertical: false }], // ┉
  [0x250a, { count: 4, weight: L, vertical: true }], // ┊
  [0x250b, { count: 4, weight: H, vertical: true }], // ┋
  [0x254c, { count: 2, weight: L, vertical: false }], // ╌
  [0x254d, { count: 2, weight: H, vertical: false }], // ╍
  [0x254e, { count: 2, weight: L, vertical: true }], // ╎
  [0x254f, { count: 2, weight: H, vertical: true }], // ╏
]);

// Quarter-circle arcs. Corner identifies which quadrant of the cell
// holds the arc, matching Ghostty's `Corner` enum.
type Corner = 'tl' | 'tr' | 'bl' | 'br';

const ARC = new Map<number, Corner>([
  // ╭ down and right: arc lives in the BOTTOM-RIGHT quadrant, connecting
  // a stroke going DOWN out of the cell to a stroke going RIGHT.
  [0x256d, 'br'],
  [0x256e, 'bl'], // ╮ down-left
  [0x256f, 'tl'], // ╯ up-left
  [0x2570, 'tr'], // ╰ up-right
]);

function drawBoxLine(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  lightPx: number
): boolean {
  if (cp === 0x2571 || cp === 0x2572 || cp === 0x2573) {
    drawDiagonal(ctx, cp, x, y, w, h, color, lightPx);
    return true;
  }

  const arc = ARC.get(cp);
  if (arc !== undefined) {
    drawArc(ctx, arc, x, y, w, h, color, lightPx);
    return true;
  }

  const dash = DASHED.get(cp);
  if (dash !== undefined) {
    drawDashed(ctx, dash, x, y, w, h, color, lightPx);
    return true;
  }

  const e = EDGES.get(cp);
  if (e === undefined) return false;

  drawEdges(ctx, e, x, y, w, h, color, lightPx);
  return true;
}

// ----------------------------------------------------------------------------
// Orthogonal box drawing
//
// Ports Ghostty's `box.zig:linesChar` (lines 399-636). Each of the four
// arms (up/right/down/left) is drawn as one or two rectangles. The key
// detail is the junction-aware endpoint of each arm:
//
//   - `up_bottom` is how far DOWN from the cell top the up-arm extends.
//     It's the bottom of the up rectangle.
//   - `down_top` is how far DOWN the down-arm starts.
//   - `left_right` and `right_left` are the analogous values along x.
//
// These are computed so that:
//   - a heavy crossbar fully covers a light perpendicular arm at the join,
//   - a light arm stops at the top/left edge of the perpendicular crossbar
//     in symmetric junctions (so we don't double-paint the crossbar),
//   - in double-line corners, each parallel of the double stroke stops at
//     the inner edge of the orthogonal stroke, forming a clean inner "L".

function drawEdges(
  ctx: CanvasRenderingContext2D,
  e: Edges,
  ox: number,
  oy: number,
  w: number,
  h: number,
  color: string,
  lt: number
): void {
  const ht = heavyThickness(lt);

  // Horizontal stroke positions (y coordinates). At realistic cell
  // sizes (lt ≈ 1, h ≈ 20) all of these are well-positive, but we
  // clamp at 0 to match Ghostty's saturating-subtraction (`-|`,
  // box.zig:408-435) so a degenerate-tiny cell doesn't produce
  // negative-coordinate rects. Note: at `lt > h` derived values like
  // `h_heavy_bottom = h_heavy_top + ht` can still extend past `h` —
  // that's also faithful to Ghostty (overdraw, not negative coords).
  const h_light_top = Math.max(0, (h - lt) / 2);
  const h_light_bottom = h_light_top + lt;
  const h_heavy_top = Math.max(0, (h - ht) / 2);
  const h_heavy_bottom = h_heavy_top + ht;
  const h_double_top = Math.max(0, h_light_top - lt);
  const h_double_bottom = h_light_bottom + lt;

  // Vertical stroke positions (x coordinates). Same clamp.
  const v_light_left = Math.max(0, (w - lt) / 2);
  const v_light_right = v_light_left + lt;
  const v_heavy_left = Math.max(0, (w - ht) / 2);
  const v_heavy_right = v_heavy_left + ht;
  const v_double_left = Math.max(0, v_light_left - lt);
  const v_double_right = v_light_right + lt;

  // Bottom of the up-arm.
  let up_bottom: number;
  if (e.l === H || e.r === H) {
    up_bottom = h_heavy_bottom;
  } else if (e.l !== e.r || e.d === e.u) {
    up_bottom = e.l === D || e.r === D ? h_double_bottom : h_light_bottom;
  } else if (e.l === N && e.r === N) {
    up_bottom = h_light_bottom;
  } else {
    up_bottom = h_light_top;
  }

  // Top of the down-arm.
  let down_top: number;
  if (e.l === H || e.r === H) {
    down_top = h_heavy_top;
  } else if (e.l !== e.r || e.u === e.d) {
    down_top = e.l === D || e.r === D ? h_double_top : h_light_top;
  } else if (e.l === N && e.r === N) {
    down_top = h_light_top;
  } else {
    down_top = h_light_bottom;
  }

  // Right edge of the left-arm.
  let left_right: number;
  if (e.u === H || e.d === H) {
    left_right = v_heavy_right;
  } else if (e.u !== e.d || e.l === e.r) {
    left_right = e.u === D || e.d === D ? v_double_right : v_light_right;
  } else if (e.u === N && e.d === N) {
    left_right = v_light_right;
  } else {
    left_right = v_light_left;
  }

  // Left edge of the right-arm.
  let right_left: number;
  if (e.u === H || e.d === H) {
    right_left = v_heavy_left;
  } else if (e.u !== e.d || e.r === e.l) {
    right_left = e.u === D || e.d === D ? v_double_left : v_light_left;
  } else if (e.u === N && e.d === N) {
    right_left = v_light_left;
  } else {
    right_left = v_light_right;
  }

  ctx.fillStyle = color;
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
  };

  // UP arm.
  switch (e.u) {
    case L:
      rect(v_light_left, 0, v_light_right, up_bottom);
      break;
    case H:
      rect(v_heavy_left, 0, v_heavy_right, up_bottom);
      break;
    case D: {
      const left_bottom = e.l === D ? h_light_top : up_bottom;
      const right_bottom = e.r === D ? h_light_top : up_bottom;
      rect(v_double_left, 0, v_light_left, left_bottom);
      rect(v_light_right, 0, v_double_right, right_bottom);
      break;
    }
  }

  // RIGHT arm.
  switch (e.r) {
    case L:
      rect(right_left, h_light_top, w, h_light_bottom);
      break;
    case H:
      rect(right_left, h_heavy_top, w, h_heavy_bottom);
      break;
    case D: {
      const top_left = e.u === D ? v_light_right : right_left;
      const bottom_left = e.d === D ? v_light_right : right_left;
      rect(top_left, h_double_top, w, h_light_top);
      rect(bottom_left, h_light_bottom, w, h_double_bottom);
      break;
    }
  }

  // DOWN arm.
  switch (e.d) {
    case L:
      rect(v_light_left, down_top, v_light_right, h);
      break;
    case H:
      rect(v_heavy_left, down_top, v_heavy_right, h);
      break;
    case D: {
      const left_top = e.l === D ? h_light_bottom : down_top;
      const right_top = e.r === D ? h_light_bottom : down_top;
      rect(v_double_left, left_top, v_light_left, h);
      rect(v_light_right, right_top, v_double_right, h);
      break;
    }
  }

  // LEFT arm.
  switch (e.l) {
    case L:
      rect(0, h_light_top, left_right, h_light_bottom);
      break;
    case H:
      rect(0, h_heavy_top, left_right, h_heavy_bottom);
      break;
    case D: {
      const top_right = e.u === D ? v_light_left : left_right;
      const bottom_right = e.d === D ? v_light_left : left_right;
      rect(0, h_double_top, top_right, h_light_top);
      rect(0, h_light_bottom, bottom_right, h_double_bottom);
      break;
    }
  }
}

// ----------------------------------------------------------------------------
// Arcs (╭╮╯╰)
//
// Ports Ghostty's arc drawing (box.zig:691-777). The arc is a cubic
// Bezier with control fraction 0.25 inside a quadrant of the cell. The
// radius reaches the cell-edge midpoint (r = min(w,h)/2), so the arc
// joins flush to a straight `─` or `│` in the next cell.

function drawArc(
  ctx: CanvasRenderingContext2D,
  corner: Corner,
  ox: number,
  oy: number,
  w: number,
  h: number,
  color: string,
  lt: number
): void {
  // Verbatim port of Ghostty's `(cell_width - thick_px) / 2 + thick_px / 2`
  // (box.zig:704-705). On Ghostty's integer arithmetic this differs from
  // `cell_width / 2` when `(cell - thick)` is odd; in JS floating-point
  // the two are mathematically equal. Kept in this shape so the diff
  // against box.zig stays line-for-line obvious.
  const center_x = (w - lt) / 2 + lt / 2;
  const center_y = (h - lt) / 2 + lt / 2;
  const r = Math.min(w, h) / 2;
  const s = 0.25; // control point fraction toward the corner

  ctx.save();
  ctx.translate(ox, oy);
  ctx.strokeStyle = color;
  ctx.lineWidth = lt;
  ctx.lineCap = 'butt';
  ctx.beginPath();

  switch (corner) {
    case 'tl':
      ctx.moveTo(center_x, 0);
      ctx.lineTo(center_x, center_y - r);
      ctx.bezierCurveTo(
        center_x,
        center_y - s * r,
        center_x - s * r,
        center_y,
        center_x - r,
        center_y
      );
      ctx.lineTo(0, center_y);
      break;
    case 'tr':
      ctx.moveTo(center_x, 0);
      ctx.lineTo(center_x, center_y - r);
      ctx.bezierCurveTo(
        center_x,
        center_y - s * r,
        center_x + s * r,
        center_y,
        center_x + r,
        center_y
      );
      ctx.lineTo(w, center_y);
      break;
    case 'bl':
      ctx.moveTo(center_x, h);
      ctx.lineTo(center_x, center_y + r);
      ctx.bezierCurveTo(
        center_x,
        center_y + s * r,
        center_x - s * r,
        center_y,
        center_x - r,
        center_y
      );
      ctx.lineTo(0, center_y);
      break;
    case 'br':
      ctx.moveTo(center_x, h);
      ctx.lineTo(center_x, center_y + r);
      ctx.bezierCurveTo(
        center_x,
        center_y + s * r,
        center_x + s * r,
        center_y,
        center_x + r,
        center_y
      );
      ctx.lineTo(w, center_y);
      break;
  }

  ctx.stroke();
  ctx.restore();
}

// ----------------------------------------------------------------------------
// Dashed lines
//
// Ports Ghostty's `dashHorizontal`/`dashVertical` (box.zig:779-928). The
// horizontal and vertical variants are subtly different — both run with
// `count` total gaps, but the gaps land in different places:
//
//   - Horizontal: half a gap on each side of the run, full gaps between
//     dashes. Lets adjacent dashed cells tile into one continuous run.
//   - Vertical: zero gap at the top, full gap at the bottom, full gaps
//     between dashes. Per Ghostty's comment (box.zig:878-881): "a
//     single full-sized extra gap is preferred to two half-sized ones
//     for vertical to allow better joining to solid characters without
//     creating visible half-sized gaps."
//
// Leftover sub-pixels are distributed to dash widths (not gaps), so
// irregularity hides in dash length rather than gap spacing.

function drawDashed(
  ctx: CanvasRenderingContext2D,
  dash: Dashed,
  ox: number,
  oy: number,
  w: number,
  h: number,
  color: string,
  lt: number
): void {
  ctx.fillStyle = color;
  const t = dash.weight === H ? heavyThickness(lt) : lt;
  const count = dash.count;
  // Match Ghostty's per-dispatch desired_gap of `max(4, light)` (box.zig:73,
  // 81, 89, 97, ...). At small light thicknesses, plain `lt` produces
  // gaps that are too tight to read as "dashed" against neighboring lines.
  const desired_gap = Math.max(4, lt);

  if (dash.vertical) {
    drawDashRun(ctx, ox + (w - t) / 2, oy, t, h, count, desired_gap, lt, true);
  } else {
    drawDashRun(ctx, ox, oy + (h - t) / 2, w, t, count, desired_gap, lt, false);
  }
}

function drawDashRun(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  count: 2 | 3 | 4,
  desired_gap: number,
  lt: number,
  vertical: boolean
): void {
  const span = vertical ? h : w;

  // Below this size the dashes degenerate to nothing — fall back to a
  // solid LIGHT line, matching Ghostty's `vlineMiddle(.light)` /
  // `hlineMiddle(.light)` (box.zig:812, 891). Heavy dashes degenerate
  // to a light line, not a heavy bar.
  //
  // Note: Ghostty compares integer cell sizes (`metrics.cell_width <
  // count + count`); ours compares the fractional `span`. At the exact
  // boundary (e.g. span = 4.0 with count = 2) the two implementations
  // make the same decision, but for fractional values just above
  // (e.g. 4.001) we'll proceed with full dash math while Ghostty
  // would still produce a sensible result on integer pixels too.
  if (span < count + count) {
    if (vertical) {
      const cx = x + (w - lt) / 2;
      ctx.fillRect(cx, y, lt, h);
    } else {
      const cy = y + (h - lt) / 2;
      ctx.fillRect(x, cy, w, lt);
    }
    return;
  }

  // Cap the gap so dashes never shrink below half the available run.
  // The early-return above guarantees `span >= 2*count`, so
  // `floor(span/(2*count)) >= 1` mathematically. The Math.max(1, ...)
  // is defensive — at fractional spans near the boundary the floor
  // can't actually return 0 but the bound makes the invariant
  // explicit (Ghostty asserts the same on integer arithmetic at
  // box.zig:824).
  const gap_width = Math.min(desired_gap, Math.max(1, Math.floor(span / (2 * count))));
  const total_gap = gap_width * count;
  const total_dash = Math.floor(span - total_gap);
  const dash_width = Math.floor(total_dash / count);
  let extra = total_dash - dash_width * count;

  // Horizontal: start at half a gap so the run is centered.
  // Vertical: start at zero with the full extra gap pushed to the bottom
  // (Ghostty's `dashVertical`, box.zig:907-909).
  let pos = vertical ? 0 : Math.floor(gap_width / 2);
  for (let i = 0; i < count; i++) {
    let len = dash_width;
    if (extra > 0) {
      extra -= 1;
      len += 1;
    }
    if (vertical) {
      ctx.fillRect(x, y + pos, w, len);
    } else {
      ctx.fillRect(x + pos, y, len, h);
    }
    pos += len + gap_width;
  }
}

// ----------------------------------------------------------------------------
// Diagonals
//
// Ports Ghostty's diagonal-line code (box.zig:638-688). The line
// overshoots each corner by a fraction of a pixel along the slope so
// that anti-aliasing covers the cell corner exactly and adjacent
// diagonals tile without 1-pixel gaps at the join.

function drawDiagonal(
  ctx: CanvasRenderingContext2D,
  cp: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  color: string,
  lt: number
): void {
  const slope_x = Math.min(1, w / h);
  const slope_y = Math.min(1, h / w);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.strokeStyle = color;
  ctx.lineWidth = lt;
  ctx.lineCap = 'butt';
  ctx.beginPath();

  if (cp === 0x2571 || cp === 0x2573) {
    // ╱ ╳: forward slash (top-right to bottom-left, with overshoot).
    ctx.moveTo(w + 0.5 * slope_x, -0.5 * slope_y);
    ctx.lineTo(-0.5 * slope_x, h + 0.5 * slope_y);
  }
  if (cp === 0x2572 || cp === 0x2573) {
    // ╲ ╳: back slash (top-left to bottom-right, with overshoot).
    ctx.moveTo(-0.5 * slope_x, -0.5 * slope_y);
    ctx.lineTo(w + 0.5 * slope_x, h + 0.5 * slope_y);
  }

  ctx.stroke();
  ctx.restore();
}
