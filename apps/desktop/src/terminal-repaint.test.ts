import { describe, expect, test } from "bun:test";

import {
  ChunkedByteSequenceMatcher,
  MAX_CLAUDE_REPAINT_ROWS,
  ResizeOutputSettler,
  SYNCHRONIZED_UPDATE_END,
  calculateClaudeRepaintRows,
  calculateRepaintViewportY,
  extractClaudeCursorPositionedRepaint,
  extractClaudeFullRepaint,
  extractClaudeSynchronizedRepaint,
  shouldRunClaudeHistoryRepaint,
} from "./terminal-repaint";

const encoder = new TextEncoder();

describe("Claude terminal full repaint", () => {
  test("is strictly limited to bound Claude sessions", () => {
    const eligible = {
      provider: "claude",
      nativeBindingState: "bound",
      hasNativeSessionId: true,
      runtimeMatches: true,
      previousCols: 160,
      nextCols: 100,
      scrollbackLength: 400,
      alternateScreen: false,
      captureActive: false,
    };
    expect(shouldRunClaudeHistoryRepaint(eligible)).toBe(true);
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, provider: "codex" }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, provider: "shell" }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({
        ...eligible,
        nativeBindingState: "pending",
      }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({
        ...eligible,
        hasNativeSessionId: false,
      }),
    ).toBe(false);
  });

  test("rejects terminal states where a full Claude repaint is unsafe", () => {
    const eligible = {
      provider: "claude",
      nativeBindingState: "bound",
      hasNativeSessionId: true,
      runtimeMatches: true,
      previousCols: 160,
      nextCols: 100,
      scrollbackLength: 400,
      alternateScreen: false,
      captureActive: false,
    };
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, runtimeMatches: false }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, previousCols: null }),
    ).toBe(false);
    expect(shouldRunClaudeHistoryRepaint({ ...eligible, nextCols: 160 })).toBe(
      false,
    );
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, scrollbackLength: 0 }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, alternateScreen: true }),
    ).toBe(false);
    expect(
      shouldRunClaudeHistoryRepaint({ ...eligible, captureActive: true }),
    ).toBe(false);
  });

  test("expands enough rows for reflowed history but stays bounded", () => {
    expect(calculateClaudeRepaintRows(589, 27)).toBe(1_296);
    expect(calculateClaudeRepaintRows(0, 27)).toBeNull();
    expect(calculateClaudeRepaintRows(10_000, 27)).toBeNull();
    expect(MAX_CLAUDE_REPAINT_ROWS).toBe(2_048);
  });

  test("extracts only a complete clear followed by a full Claude repaint", () => {
    const clear = "\x1b[H" + "\x1b[2K\x1b[1B".repeat(12);
    const repaint =
      "\x1b[H╭── Claude Code\r\n│ Welcome back!\r\n" +
      "history\r\n".repeat(10) +
      "bypass permissions on (shift+tab to cycle)\r\n";
    const bytes = encoder.encode(`noise${clear}${repaint}`);
    expect(
      new TextDecoder().decode(
        extractClaudeFullRepaint([bytes.slice(0, 31), bytes.slice(31)], 12)!,
      ),
    ).toBe(repaint);
  });

  test("commits immediately only at a synchronized repaint boundary", () => {
    const clear = "\x1b[H" + "\x1b[2K\x1b[1B".repeat(12);
    const repaint =
      "\x1b[H╭── Claude Code\r\n│ Welcome back!\r\n" + "history\r\n".repeat(10);
    const synchronized = encoder.encode(`${clear}${repaint}\x1b[?2026l`);
    const split = synchronized.length - 3;

    expect(
      extractClaudeSynchronizedRepaint(
        [synchronized.slice(0, split), synchronized.slice(split)],
        12,
      ),
    ).not.toBeNull();
    expect(
      extractClaudeSynchronizedRepaint([encoder.encode(clear + repaint)], 12),
    ).toBeNull();

    const matcher = new ChunkedByteSequenceMatcher(SYNCHRONIZED_UPDATE_END);
    expect(matcher.push(SYNCHRONIZED_UPDATE_END.slice(0, 5))).toBe(false);
    expect(matcher.push(SYNCHRONIZED_UPDATE_END.slice(5))).toBe(true);
  });

  test("recognizes Claude's final cursor placement across chunks", () => {
    const clear = "\x1b[H" + "\x1b[2K\x1b[1B".repeat(12);
    const repaint =
      "\x1b[H╭── Claude Code\r\n│ Welcome back!\r\n" +
      "history\r\n".repeat(10) +
      "bypass permissions on (shift+tab to cycle)\r\n";
    const completed = encoder.encode(`${clear}${repaint}\x1b[2C\x1b[4A`);
    const split = completed.length - 2;

    expect(
      extractClaudeCursorPositionedRepaint(
        [completed.slice(0, split), completed.slice(split)],
        12,
      ),
    ).not.toBeNull();
    expect(
      extractClaudeCursorPositionedRepaint(
        [encoder.encode(`${clear}${repaint}\x1b[2C`)],
        12,
      ),
    ).toBeNull();
    expect(
      extractClaudeCursorPositionedRepaint(
        [encoder.encode(`${clear}${repaint}\x1b[4A`)],
        12,
      ),
    ).toBeNull();
    expect(
      extractClaudeCursorPositionedRepaint(
        [
          encoder.encode(
            `${clear}${repaint.replace("shift+tab", "cycle modes")}\x1b[2C\x1b[4A`,
          ),
        ],
        12,
      ),
    ).toBeNull();
  });

  test("settles Codex resize output on sync end or trailing quiet", async () => {
    const callbacks = new Map<
      number,
      { callback: () => void; delayMs: number }
    >();
    let nextHandle = 0;
    const setTimer = (callback: () => void, delayMs: number) => {
      nextHandle += 1;
      callbacks.set(nextHandle, { callback, delayMs });
      return nextHandle as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = (handle: ReturnType<typeof setTimeout>) =>
      callbacks.delete(handle as unknown as number);
    const quiet = new ResizeOutputSettler(
      "runtime-1",
      80,
      1_000,
      setTimer,
      clearTimer,
    );

    expect(quiet.push("other-runtime", encoder.encode("ignored"))).toBe(false);
    quiet.startGracePeriod();
    expect(quiet.push("runtime-1", encoder.encode("repaint"))).toBe(true);
    const quietTimer = [...callbacks.values()].find(
      ({ delayMs }) => delayMs === 80,
    );
    quietTimer?.callback();
    expect(await quiet.result).toEqual({
      completion: "quiet",
      sawOutput: true,
    });
    expect(callbacks.size).toBe(0);

    const synchronized = new ResizeOutputSettler(
      "runtime-2",
      80,
      1_000,
      setTimer,
      clearTimer,
    );
    expect(
      synchronized.push("runtime-2", SYNCHRONIZED_UPDATE_END.slice(0, 4)),
    ).toBe(true);
    expect(
      synchronized.push("runtime-2", SYNCHRONIZED_UPDATE_END.slice(4)),
    ).toBe(true);
    let synchronizedResolved = false;
    void synchronized.result.then(() => {
      synchronizedResolved = true;
    });
    await Promise.resolve();
    expect(synchronizedResolved).toBe(false);
    const synchronizedQuietTimer = [...callbacks.values()].find(
      ({ delayMs }) => delayMs === 80,
    );
    synchronizedQuietTimer?.callback();
    expect(await synchronized.result).toEqual({
      completion: "synchronized",
      sawOutput: true,
    });
    expect(callbacks.size).toBe(0);
  });

  test("preserves the relative history viewport after repaint", () => {
    expect(calculateRepaintViewportY(278, 540, 394)).toBe(203);
    expect(calculateRepaintViewportY(0, 540, 394)).toBe(0);
    expect(calculateRepaintViewportY(900, 900, 394)).toBe(394);
  });

  test("rejects partial viewport redraws and unrecognized output", () => {
    const partial = encoder.encode(
      "\x1b[H" +
        "\x1b[2K\x1b[1B".repeat(8) +
        "\x1b[HWelcome back!\r\n" +
        "line\r\n".repeat(10),
    );
    expect(extractClaudeFullRepaint([partial], 12)).toBeNull();

    const missingStart = encoder.encode(
      "\x1b[H" + "\x1b[2K\x1b[1B".repeat(12) + "\x1b[Hhistory\r\n".repeat(12),
    );
    expect(extractClaudeFullRepaint([missingStart], 12)).toBeNull();

    const lateClear = encoder.encode(
      "meaningful output before repaint".repeat(3) +
        "\x1b[H" +
        "\x1b[2K\x1b[1B".repeat(12) +
        "\x1b[HWelcome back!\r\n" +
        "line\r\n".repeat(10),
    );
    expect(extractClaudeFullRepaint([lateClear], 12)).toBeNull();
  });
});
