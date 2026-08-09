/**
 * Tests for procedural box-drawing and block-element rendering.
 *
 * happy-dom's CanvasRenderingContext2D doesn't actually rasterize, so
 * we test against a recording stub that captures every drawing call as
 * a structured op. This catches:
 *   - coverage gaps (every codepoint in U+2500..U+259F should produce
 *     at least one fillRect or stroke),
 *   - regressions in branch logic (the recorded op sequence should
 *     stay stable across refactors),
 *   - junction-aware endpoint correctness (we hand-check a handful of
 *     known-tricky glyphs against expected coordinates).
 */

import { describe, expect, test } from 'bun:test';
import { drawBoxOrBlock, isBoxOrBlock } from './box-drawing';

type Op =
  | { kind: 'fillStyle'; v: string }
  | { kind: 'strokeStyle'; v: string }
  | { kind: 'lineWidth'; v: number }
  | { kind: 'lineCap'; v: string }
  | { kind: 'globalAlpha'; v: number }
  | { kind: 'fillRect'; x: number; y: number; w: number; h: number }
  | { kind: 'save' }
  | { kind: 'restore' }
  | { kind: 'beginPath' }
  | { kind: 'moveTo'; x: number; y: number }
  | { kind: 'lineTo'; x: number; y: number }
  | { kind: 'bezierCurveTo'; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }
  | { kind: 'stroke' }
  | { kind: 'translate'; x: number; y: number };

interface RecordingCtx {
  ops: Op[];
  // Mirrored from CanvasRenderingContext2D for type compat.
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ): void;
  stroke(): void;
  translate(x: number, y: number): void;
}

function makeCtx(): RecordingCtx {
  const ops: Op[] = [];
  let fillStyleBacking = '#000';
  let strokeStyleBacking = '#000';
  let lineWidthBacking = 1;
  let lineCapBacking = 'butt';
  let globalAlphaBacking = 1;
  return {
    ops,
    get fillStyle() {
      return fillStyleBacking;
    },
    set fillStyle(v: string) {
      fillStyleBacking = v;
      ops.push({ kind: 'fillStyle', v });
    },
    get strokeStyle() {
      return strokeStyleBacking;
    },
    set strokeStyle(v: string) {
      strokeStyleBacking = v;
      ops.push({ kind: 'strokeStyle', v });
    },
    get lineWidth() {
      return lineWidthBacking;
    },
    set lineWidth(v: number) {
      lineWidthBacking = v;
      ops.push({ kind: 'lineWidth', v });
    },
    get lineCap() {
      return lineCapBacking;
    },
    set lineCap(v: string) {
      lineCapBacking = v;
      ops.push({ kind: 'lineCap', v });
    },
    get globalAlpha() {
      return globalAlphaBacking;
    },
    set globalAlpha(v: number) {
      globalAlphaBacking = v;
      ops.push({ kind: 'globalAlpha', v });
    },
    fillRect(x, y, w, h) {
      ops.push({ kind: 'fillRect', x, y, w, h });
    },
    save() {
      ops.push({ kind: 'save' });
    },
    restore() {
      ops.push({ kind: 'restore' });
    },
    beginPath() {
      ops.push({ kind: 'beginPath' });
    },
    moveTo(x, y) {
      ops.push({ kind: 'moveTo', x, y });
    },
    lineTo(x, y) {
      ops.push({ kind: 'lineTo', x, y });
    },
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
      ops.push({ kind: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
    },
    stroke() {
      ops.push({ kind: 'stroke' });
    },
    translate(x, y) {
      ops.push({ kind: 'translate', x, y });
    },
  };
}

// Standard cell for tests: 10x20 with a 1px light stroke.
const CW = 10;
const CH = 20;
const LT = 1;
const COLOR = '#fff';

function draw(cp: number, lightPx = LT) {
  const ctx = makeCtx();
  const handled = drawBoxOrBlock(
    ctx as unknown as CanvasRenderingContext2D,
    cp,
    0,
    0,
    CW,
    CH,
    COLOR,
    lightPx
  );
  return { ctx, handled };
}

function rectsOnly(ops: Op[]): { x: number; y: number; w: number; h: number }[] {
  return ops.flatMap((o) => (o.kind === 'fillRect' ? [{ x: o.x, y: o.y, w: o.w, h: o.h }] : []));
}

describe('box-drawing', () => {
  describe('isBoxOrBlock', () => {
    test('matches U+2500..U+259F', () => {
      expect(isBoxOrBlock(0x2500)).toBe(true);
      expect(isBoxOrBlock(0x257f)).toBe(true);
      expect(isBoxOrBlock(0x2580)).toBe(true);
      expect(isBoxOrBlock(0x259f)).toBe(true);
    });
    test('rejects neighbors', () => {
      expect(isBoxOrBlock(0x24ff)).toBe(false);
      expect(isBoxOrBlock(0x25a0)).toBe(false);
      expect(isBoxOrBlock(0x4e00)).toBe(false);
      expect(isBoxOrBlock(0x20)).toBe(false);
    });
  });

  describe('coverage', () => {
    // Exhaustive check that every codepoint in the range U+2500..U+259F
    // (160 codepoints) produces at least one drawing op. A regression
    // means a glyph is silently falling back to font rendering. This
    // test is weak on its own — a dispatch swap (▖↔▗) would still
    // pass — so the per-glyph shape assertions later in this file
    // do the actual correctness checking. This test catches *missing*
    // dispatch entries, not *wrong* ones.
    test('every codepoint U+2500..U+259F draws something visible', () => {
      const missing: number[] = [];
      for (let cp = 0x2500; cp <= 0x259f; cp++) {
        const { ctx, handled } = draw(cp);
        // Require a *non-degenerate* fillRect or a stroke — a 0×0
        // fillRect would slip through the looser `o.kind === ...`
        // check.
        const drewSomething = ctx.ops.some(
          (o) =>
            (o.kind === 'fillRect' && o.w > 0 && o.h > 0) ||
            o.kind === 'stroke'
        );
        if (!handled || !drewSomething) missing.push(cp);
      }
      expect(missing).toEqual([]);
    });
  });

  describe('block elements (U+2580..U+259F)', () => {
    test('▀ U+2580 upper half = top-half rect', () => {
      const { ctx } = draw(0x2580);
      expect(rectsOnly(ctx.ops)).toEqual([{ x: 0, y: 0, w: CW, h: CH / 2 }]);
    });
    test('▄ U+2584 lower half = bottom-half rect', () => {
      const { ctx } = draw(0x2584);
      expect(rectsOnly(ctx.ops)).toEqual([{ x: 0, y: CH / 2, w: CW, h: CH / 2 }]);
    });
    test('█ U+2588 full block = full-cell rect', () => {
      const { ctx } = draw(0x2588);
      expect(rectsOnly(ctx.ops)).toEqual([{ x: 0, y: 0, w: CW, h: CH }]);
    });
    test('▏ U+258F left 1/8 = thin left rect', () => {
      const { ctx } = draw(0x258f);
      expect(rectsOnly(ctx.ops)).toEqual([{ x: 0, y: 0, w: CW / 8, h: CH }]);
    });
    test('▕ U+2595 right 1/8 = thin right rect, touches right edge', () => {
      const { ctx } = draw(0x2595);
      const rects = rectsOnly(ctx.ops);
      expect(rects).toHaveLength(1);
      const [r] = rects;
      expect(r.x + r.w).toBeCloseTo(CW, 9);
      expect(r.w).toBeCloseTo(CW / 8, 9);
      expect(r.h).toBe(CH);
    });
    test('▁ U+2581 lower 1/8 = bottom rect, touches bottom edge', () => {
      const { ctx } = draw(0x2581);
      const rects = rectsOnly(ctx.ops);
      expect(rects).toHaveLength(1);
      const [r] = rects;
      expect(r.y + r.h).toBeCloseTo(CH, 9);
    });
    test('▙ U+2599 = three quadrants (tl + bl + br)', () => {
      // Per block.zig:93: tl + bl + br. The quadrant() helper emits
      // one rect per active quadrant, in tl/tr/bl/br order.
      const { ctx } = draw(0x2599);
      const rects = rectsOnly(ctx.ops);
      expect(rects).toEqual([
        { x: 0, y: 0, w: CW / 2, h: CH / 2 }, // tl
        { x: 0, y: CH / 2, w: CW / 2, h: CH / 2 }, // bl
        { x: CW / 2, y: CH / 2, w: CW / 2, h: CH / 2 }, // br
      ]);
    });

    // Per-codepoint quadrant assertions catch dispatch swaps (e.g. if
    // ▖↔▗ get switched in the case list, the bare "draws something"
    // coverage test wouldn't notice — this would). 9 of 10 quadrant
    // glyphs are listed here; ▙ (U+2599) is covered by the dedicated
    // test above so it's not duplicated here.
    const tl = { x: 0, y: 0, w: CW / 2, h: CH / 2 };
    const tr = { x: CW / 2, y: 0, w: CW / 2, h: CH / 2 };
    const bl = { x: 0, y: CH / 2, w: CW / 2, h: CH / 2 };
    const br = { x: CW / 2, y: CH / 2, w: CW / 2, h: CH / 2 };
    test.each([
      [0x2596, 'lower-left ▖', [bl]],
      [0x2597, 'lower-right ▗', [br]],
      [0x2598, 'upper-left ▘', [tl]],
      [0x259d, 'upper-right ▝', [tr]],
      [0x259a, 'tl + br ▚', [tl, br]],
      [0x259e, 'tr + bl ▞', [tr, bl]],
      [0x259b, 'tl + tr + bl ▛', [tl, tr, bl]],
      [0x259c, 'tl + tr + br ▜', [tl, tr, br]],
      [0x259f, 'tr + bl + br ▟', [tr, bl, br]],
    ])('U+%s quadrant glyph %s', (cp, _name, expected) => {
      expect(rectsOnly(draw(cp).ctx.ops)).toEqual(expected);
    });

    test('░ U+2591 light shade applies ~25% alpha multiplier', () => {
      const { ctx } = draw(0x2591);
      const alphaOp = ctx.ops.find((o) => o.kind === 'globalAlpha');
      expect(alphaOp).toBeTruthy();
      // Tolerance covers both our 0.25 and Ghostty's 0x40/255 = 0.2509…
      // A future change to match Ghostty exactly should still pass.
      if (alphaOp && alphaOp.kind === 'globalAlpha') {
        expect(alphaOp.v).toBeCloseTo(0.25, 2);
      }
      // And the alpha is applied within save/restore.
      expect(ctx.ops[0]?.kind).toBe('save');
      expect(ctx.ops[ctx.ops.length - 1]?.kind).toBe('restore');
    });
  });

  describe('line drawing (U+2500..U+257F)', () => {
    // drawEdges emits one fillRect per non-empty arm (left, right, up,
    // down). Adjacent arms overlap at the cell center to cover the
    // junction. So a plain horizontal `─` is 2 rects (left arm + right
    // arm), not 1. We assert the union of rects, not individual counts.
    test('─ U+2500 light horizontal: arms cover full width at vertical center', () => {
      const { ctx } = draw(0x2500);
      const rects = rectsOnly(ctx.ops);
      expect(rects.length).toBeGreaterThanOrEqual(1);
      // All rects sit at the vertical center, light-thick high.
      for (const r of rects) {
        expect(r.h).toBe(LT);
        expect(r.y + r.h / 2).toBeCloseTo(CH / 2, 9);
      }
      // Union covers full cell width.
      const minX = Math.min(...rects.map((r) => r.x));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      expect(minX).toBe(0);
      expect(maxX).toBe(CW);
    });
    test('│ U+2502 light vertical: arms cover full height at horizontal center', () => {
      const { ctx } = draw(0x2502);
      const rects = rectsOnly(ctx.ops);
      expect(rects.length).toBeGreaterThanOrEqual(1);
      for (const r of rects) {
        expect(r.w).toBe(LT);
        expect(r.x + r.w / 2).toBeCloseTo(CW / 2, 9);
      }
      const minY = Math.min(...rects.map((r) => r.y));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      expect(minY).toBe(0);
      expect(maxY).toBe(CH);
    });
    test('━ U+2501 heavy horizontal: rects are 2× light thickness', () => {
      const { ctx } = draw(0x2501);
      const rects = rectsOnly(ctx.ops);
      expect(rects.length).toBeGreaterThanOrEqual(1);
      for (const r of rects) {
        expect(r.h).toBe(2 * LT);
      }
    });
    test('═ U+2550 double horizontal: two parallel light strokes, 1-light gap', () => {
      const { ctx } = draw(0x2550);
      const rects = rectsOnly(ctx.ops);
      // Two arms × two parallels per arm = 4 rects.
      expect(rects).toHaveLength(4);
      // All are light-thick.
      for (const r of rects) {
        expect(r.h).toBe(LT);
      }
      // The four rects collapse into two distinct y-bands. The gap
      // between bands should equal one light thickness (Ghostty's
      // double-line spec: total span = 3 × light).
      const ys = [...new Set(rects.map((r) => r.y))].sort((a, b) => a - b);
      expect(ys).toHaveLength(2);
      expect(ys[1] - ys[0]).toBeCloseTo(2 * LT, 9);
    });
    test('┼ U+253C light cross = all four arms cover their respective edges', () => {
      const { ctx } = draw(0x253c);
      const rects = rectsOnly(ctx.ops);
      // ┼ has all four arms (l/r/u/d = light). Each arm is one
      // fillRect so we expect exactly 4 rects. A bug that drops the
      // up- or right-arm switch case must fail this test, so we
      // assert per-arm coverage in addition to the rect count.
      expect(rects).toHaveLength(4);

      // Vertical-axis arms (up + down) are narrow rects roughly
      // light-thick wide; horizontal-axis arms are wide rects roughly
      // light-thick tall. Filter by the rect's narrow dimension to
      // separate them — this is unambiguous because none of the
      // light-cross arms share both dimensions.
      const verticalArms = rects.filter((r) => r.w <= 2 * LT);
      const horizontalArms = rects.filter((r) => r.h <= 2 * LT);
      expect(verticalArms.length).toBeGreaterThanOrEqual(1);
      expect(horizontalArms.length).toBeGreaterThanOrEqual(1);

      // Up arm reaches y=0 and down arm reaches y=CH.
      const minY = Math.min(...verticalArms.map((r) => r.y));
      const maxY = Math.max(...verticalArms.map((r) => r.y + r.h));
      expect(minY).toBe(0);
      expect(maxY).toBe(CH);

      // Left arm reaches x=0 and right arm reaches x=CW.
      const minX = Math.min(...horizontalArms.map((r) => r.x));
      const maxX = Math.max(...horizontalArms.map((r) => r.x + r.w));
      expect(minX).toBe(0);
      expect(maxX).toBe(CW);
    });
    test('╔ U+2554 double down-right corner: junction-aware inner L', () => {
      // Regression check for the junction-aware-endpoints fix. With
      // CW=10, CH=20, LT=1, the four expected rects are derived from
      // box.zig's `linesChar` algorithm:
      //   v_light_left=4.5, v_light_right=5.5
      //   v_double_left=3.5, v_double_right=6.5
      //   h_light_top=9.5,  h_light_bottom=10.5
      //   h_double_top=8.5, h_double_bottom=11.5
      //
      // The OUTER L (top-left of the corner) is formed by rect (1) +
      // rect (3) meeting at (v_double_left, h_double_top). The INNER
      // strokes stop at the perpendicular's inner edge (rect 2 starts
      // at v_light_right, rect 4 starts at h_light_bottom), so the
      // upper-left interior of the corner is left empty — that's what
      // makes a clean double-line corner instead of crossing parallels.
      const { ctx } = draw(0x2554);
      const rects = rectsOnly(ctx.ops);
      expect(rects).toEqual([
        // Top outer horizontal: from outer-left to right edge.
        { x: 3.5, y: 8.5, w: 6.5, h: 1 },
        // Top inner horizontal: starts at v_light_right (the inner
        // corner), so it does NOT cross the upper-left quadrant.
        { x: 5.5, y: 10.5, w: 4.5, h: 1 },
        // Left outer vertical: from outer-top to bottom edge.
        { x: 3.5, y: 8.5, w: 1, h: 11.5 },
        // Right inner vertical: starts at h_light_bottom, doesn't
        // cross the upper-left quadrant.
        { x: 5.5, y: 10.5, w: 1, h: 9.5 },
      ]);

      // The buggy version had every parallel extending to cell center,
      // so a rect would have covered the open inner area. Sanity-check
      // by asserting no rect touches the inner-corner test point that
      // should remain empty.
      const innerOpenX = 4.5; // just above v_light_right
      const innerOpenY = 10; // just below h_light_top
      for (const r of rects) {
        const covers =
          r.x <= innerOpenX &&
          innerOpenX < r.x + r.w &&
          r.y <= innerOpenY &&
          innerOpenY < r.y + r.h;
        expect(covers).toBe(false);
      }
    });
  });

  describe('arcs (╭╮╯╰)', () => {
    test('╭ U+256D draws bezier path with stroke, not fill', () => {
      const { ctx } = draw(0x256d);
      // Arcs use stroke, not fill — they emit beginPath/moveTo/lineTo/
      // bezierCurveTo/stroke and no fillRect.
      expect(ctx.ops.some((o) => o.kind === 'bezierCurveTo')).toBe(true);
      expect(ctx.ops.some((o) => o.kind === 'stroke')).toBe(true);
      expect(ctx.ops.some((o) => o.kind === 'fillRect')).toBe(false);
    });
  });

  describe('dashes', () => {
    // Concrete expected coordinates rather than re-deriving the
    // implementation in the test. These were hand-computed from
    // Ghostty's `dashHorizontal`/`dashVertical` algorithm against the
    // standard CW=10, CH=20, LT=1 cell.

    test('┄ U+2504 horizontal triple-dash: half-gaps on each side, extra in dashes', () => {
      // desired_gap = max(4, 1) = 4, cap = floor(10/6) = 1, gap = 1
      // total_gap = 3, total_dash = 7, dash_w = 2, extra = 1 (goes to dash 0)
      // pos starts at floor(1/2) = 0
      // → dash 0 at x=0 w=3, dash 1 at x=4 w=2, dash 2 at x=7 w=2
      const { ctx } = draw(0x2504);
      const rects = rectsOnly(ctx.ops);
      const cy = (CH - LT) / 2;
      expect(rects).toEqual([
        { x: 0, y: cy, w: 3, h: LT },
        { x: 4, y: cy, w: 2, h: LT },
        { x: 7, y: cy, w: 2, h: LT },
      ]);
      // Half-gap-on-each-side invariant: the leftmost dash starts at
      // floor(gap/2) and the rightmost dash ends at total_run -
      // floor(gap/2). Same gap on both sides → adjacent dashed cells
      // tile.
      const lastDash = rects[rects.length - 1];
      expect(rects[0].x).toBe(0);
      expect(CW - (lastDash.x + lastDash.w)).toBe(1);
    });

    test('┆ U+2506 vertical triple-dash: zero gap at top, full gap at bottom', () => {
      // desired_gap=4, cap=floor(20/6)=3, gap=3
      // total_gap=9, total_dash=11, dash_h=3, extra=2
      // pos starts at 0
      // → dash 0 at y=0 h=4, dash 1 at y=7 h=4, dash 2 at y=14 h=3
      const { ctx } = draw(0x2506);
      const rects = rectsOnly(ctx.ops);
      const cx = (CW - LT) / 2;
      expect(rects).toEqual([
        { x: cx, y: 0, w: LT, h: 4 },
        { x: cx, y: 7, w: LT, h: 4 },
        { x: cx, y: 14, w: LT, h: 3 },
      ]);
      // The Ghostty asymmetry invariant (box.zig:878-881): no gap on
      // top, full gap below the last dash.
      expect(rects[0].y).toBe(0);
      const last = rects[rects.length - 1];
      expect(CH - (last.y + last.h)).toBe(3); // == gap_width
    });

    test('┈ U+2508 horizontal quad-dash: 4 rects', () => {
      expect(rectsOnly(draw(0x2508).ctx.ops)).toHaveLength(4);
    });
    test('╌ U+254C horizontal double-dash: 2 rects', () => {
      expect(rectsOnly(draw(0x254c).ctx.ops)).toHaveLength(2);
    });
    test('heavy-dash degenerate fallback uses LIGHT thickness, not heavy', () => {
      // When the cell is too small to hold `count + count` of anything,
      // the implementation falls back to a solid line. Ghostty falls
      // back to a LIGHT line regardless of dash weight (vlineMiddle/
      // hlineMiddle take .light), so a heavy dash at a tiny cell size
      // shouldn't suddenly turn into a heavy bar.
      const ctx = makeCtx();
      drawBoxOrBlock(
        ctx as unknown as CanvasRenderingContext2D,
        0x2505, // ━━━ heavy triple dash
        0,
        0,
        2, // tiny cell — degenerate
        20,
        COLOR,
        1
      );
      const rects = rectsOnly(ctx.ops);
      expect(rects).toHaveLength(1);
      expect(rects[0].h).toBe(1); // LIGHT, not 2 (heavy)
    });
  });

  describe('diagonals (╱╲╳)', () => {
    test('╱ U+2571 forward slash = single stroked line', () => {
      const { ctx } = draw(0x2571);
      const lines = ctx.ops.filter((o) => o.kind === 'lineTo' || o.kind === 'moveTo');
      expect(lines).toHaveLength(2); // one moveTo, one lineTo
      expect(ctx.ops.some((o) => o.kind === 'stroke')).toBe(true);
    });
    test('╳ U+2573 cross = two stroked lines', () => {
      const { ctx } = draw(0x2573);
      const moves = ctx.ops.filter((o) => o.kind === 'moveTo');
      const lines = ctx.ops.filter((o) => o.kind === 'lineTo');
      expect(moves).toHaveLength(2);
      expect(lines).toHaveLength(2);
    });
  });
});
