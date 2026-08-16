import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { CliSessionDto } from "../generated/CliSessionDto";
import type { RuntimeEvent } from "../generated/RuntimeEvent";
import type { TabDto } from "../generated/TabDto";
import { FrameTaskScheduler } from "../frame-task-scheduler";
import { focusWhenPanelActive } from "../panel-visibility";
import { RetainedRendererCache } from "../retained-renderer-cache";
import {
  LatestValue,
  OscSequenceStripper,
  type QueuedByteChunk,
  runtimeStartCanCommit,
  shouldAutoStartCliRuntime,
  takeByteBatch,
} from "../terminal-flow";
import {
  cliShortcutInput,
  installCliInputFollow,
  isAgentCliCopyShortcut,
} from "../terminal-keyboard";
import {
  isDockGeometrySettled,
  isRenderableTerminalViewport,
  isTerminalResizeHandle,
  TerminalFitSettler,
  TerminalFrameSwap,
} from "../terminal-layout";
import {
  ChunkedByteSequenceMatcher,
  MAX_CLAUDE_REPAINT_BYTES,
  ResizeOutputSettler,
  SYNCHRONIZED_UPDATE_END,
  calculateClaudeRepaintRows,
  calculateRepaintViewportY,
  extractClaudeCursorPositionedRepaint,
  extractClaudeFullRepaint,
  extractClaudeSynchronizedRepaint,
  shouldRunClaudeHistoryRepaint,
  shouldSettleResizePresentation,
} from "../terminal-repaint";
import { TERMINAL_THEMES, type ThemeMode } from "../theme";
import {
  FilePathLinkProvider,
  classifyTerminalUri,
  type TerminalFileReference,
  type TerminalLinkTarget,
} from "../terminal-links";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
import { uiIcon } from "../ui-icons";
import {
  FitAddon,
  Ghostty,
  Terminal,
} from "../../vendor/ghostty-web/lib/index.ts";
import ghosttyWasmUrl from "../../vendor/ghostty-web/ghostty-vt.wasm?url";
import {
  TERMINAL_FONT_CELL_HEIGHT,
  TERMINAL_FONT_CELL_WIDTH,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "../terminal-typography";
import type { TabProvider } from "./registry";

const SCROLLBACK_BYTES = 64 * 1024 * 1024;
const OUTPUT_BUDGET_PER_FRAME = 8 * 1024;
const FIT_DEBOUNCE_MS = 80;
const CLAUDE_REPAINT_QUIET_MS = 400;
const CLAUDE_REPAINT_TIMEOUT_MS = 12_000;
const TUI_REPAINT_QUIET_MS = 200;
const TUI_REPAINT_TIMEOUT_MS = 1_000;
const OUTPUT_DRAIN_TIMEOUT_MS = 8_000;
const FRAME_FALLBACK_MS = 100;

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let frame: number | null = null;
    let fallback: number | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (fallback !== null) window.clearTimeout(fallback);
      resolve();
    };
    frame = requestAnimationFrame(finish);
    if (!settled) fallback = window.setTimeout(finish, FRAME_FALLBACK_MS);
  });
}

function loadIsolatedGhostty(): Promise<Ghostty> {
  // Each retained renderer owns its WASM allocator and RenderState arena.
  // Sharing one Ghostty instance lets a freshly allocated terminal observe a
  // released terminal's cached RenderState before the first full redraw.
  return Ghostty.load(ghosttyWasmUrl);
}

export class TerminalTabProvider implements TabProvider {
  readonly kind = "cli-session" as const;
  readonly #renderers = new RetainedRendererCache<TerminalPanel>();

  constructor(
    private readonly client: CcsmDesktopClient,
    private theme: ThemeMode,
    private readonly openLink: (request: TerminalLinkOpenRequest) => void,
  ) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return this.#renderers.getOrCreate(
      tab.id,
      () => new TerminalPanel(tab, this.client, this.theme, this.openLink),
    );
  }

  setTheme(theme: ThemeMode): void {
    this.theme = theme;
    this.#renderers.forEach((renderer) => renderer.setTheme(theme));
  }

  focusTab(tabId: string): boolean {
    const renderer = this.#renderers.get(tabId);
    if (!renderer) return false;
    renderer.focus();
    return true;
  }

  liveRuntimeCount(): number {
    let count = 0;
    this.#renderers.forEach((renderer) => {
      if (renderer.hasLiveRuntime()) count += 1;
    });
    return count;
  }

  releaseTabs(tabIds: Iterable<string>): void {
    this.#renderers.release(tabIds);
  }

  destroyAll(): void {
    this.#renderers.destroyAll();
  }
}

class TerminalPanel implements IContentRenderer {
  readonly element = document.createElement("section");
  readonly #fitAddon = new FitAddon();
  readonly #tab: TabDto;
  readonly #client: CcsmDesktopClient;
  #terminal: Terminal | null = null;
  #host: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #meta: HTMLElement | null = null;
  #action: HTMLButtonElement | null = null;
  #session: CliSessionDto | null = null;
  #runtimeId: string | null = null;
  #starting = false;
  #manualStopBlocked = false;
  #initialized = false;
  #attached = false;
  #destroyed = false;
  #resizeObserver: ResizeObserver | null = null;
  #panelApi: GroupPanelPartInitParameters["api"] | null = null;
  #dimensionSubscription: { dispose(): void } | null = null;
  #visibilitySubscription: { dispose(): void } | null = null;
  #activeSubscription: { dispose(): void } | null = null;
  readonly #resizeScheduler = new FrameTaskScheduler(1);
  readonly #fitFrameScheduler = new FrameTaskScheduler(1);
  readonly #fitSettler = new TerminalFitSettler(FIT_DEBOUNCE_MS, () =>
    this.#requestFitFrame(),
  );
  #fitCount = 0;
  #hasValidFit = false;
  #fitSuppressedForTransientViewport = false;
  readonly #frameSwap = new TerminalFrameSwap(this.element);
  readonly #fitWaiters = new Set<() => void>();
  #resizeInFlight = false;
  readonly #pendingResize = new LatestValue<{ cols: number; rows: number }>();
  #backendSize: { cols: number; rows: number } | null = null;
  #repaintCapture: ClaudeRepaintCapture | null = null;
  #historyRepaintCount = 0;
  #historyRepaintFastCount = 0;
  #historyRepaintFailureCount = 0;
  #lastRepaintCompletion: ClaudeRepaintCaptureResult["completion"] | null =
    null;
  #lastRepaintSynchronizedEnds = 0;
  #resizeOutputSettler: ResizeOutputSettler | null = null;
  #resizePresentationCount = 0;
  #lastResizePresentationCompletion: string | null = null;
  readonly #outputQueue: QueuedByteChunk[] = [];
  readonly #oscStripper = new OscSequenceStripper({
    preserveDynamicColorQueries: true,
  });
  readonly #outputFrameScheduler = new FrameTaskScheduler(1);
  #outputWriteInFlight = false;
  #outputWriteCredits: Array<{ runtimeId: string; bytes: number }> = [];
  readonly #pendingOutputAcks = new Map<string, number>();
  #outputAckInFlight = false;
  #outputAckBytesInFlight = 0;
  #renderFailureCount = 0;
  #pendingExitCode: number | null = null;
  readonly #exitedRuntimeIds = new Set<string>();
  #inputQueue: Promise<void> = Promise.resolve();
  #resetOnNextRuntimeOutput = false;
  #lastOutputRuntimeId: string | null = null;
  #inputFollowDispose: (() => void) | null = null;
  #resizeGestureDispose: (() => void) | null = null;
  #unlisten: (() => void) | null = null;

  constructor(
    tab: TabDto,
    client: CcsmDesktopClient,
    private theme: ThemeMode,
    private readonly openLink: (request: TerminalLinkOpenRequest) => void,
  ) {
    this.#tab = tab;
    this.#client = client;
    this.element.className = "terminal-panel";
    this.element.dataset.cliSessionId = tab.resourceId ?? "";
    (this.element as TerminalDebugElement).__CCSM_TERMINAL_DEBUG__ = () =>
      this.#debugSnapshot();
    this.element.innerHTML = `
      <div class="terminal-host" data-testid="terminal-input-surface" aria-label="Terminal"></div>
      <div class="terminal-panel-toolbar">
        <span class="terminal-status" data-state="starting">loading terminal</span>
        <span class="terminal-meta">—</span>
        <button class="terminal-action control-button" data-testid="terminal-runtime-action" type="button">
          <span class="control-icon">${uiIcon("stop")}</span>
          <span class="terminal-action-label">Stop</span>
        </button>
      </div>
    `;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.#panelApi = parameters.api;
    this.#attached = true;
    this.#bindPanelEvents(parameters.api);
    this.#host = this.element.querySelector(".terminal-host");
    this.#status = this.element.querySelector(".terminal-status");
    this.#meta = this.element.querySelector(".terminal-meta");
    this.#action = this.element.querySelector(".terminal-action");
    this.#syncInputState();
    this.#installResizeGestureGuard();
    this.#observeSize();
    this.#scheduleFit();
    if (this.#initialized) return;
    this.#initialized = true;
    this.#action?.addEventListener("click", () => {
      void this.#handleAction();
    });
    void this.#client.events
      .subscribe((event) => {
        if (
          event.kind === "session.bindingChanged" &&
          event.payload.cliSessionId === this.#tab.resourceId &&
          this.#session
        ) {
          this.#session.nativeSessionId = event.payload.nativeSessionId;
          this.#session.nativeBindingState = event.payload.nativeBindingState;
          this.#renderRuntimeStatus();
        }
      })
      .then((unlisten) => {
        if (this.#destroyed) unlisten();
        else this.#unlisten = unlisten;
      });
    void this.#initialize();
  }

  layout(): void {
    this.#scheduleFit();
  }

  onShow(): void {
    this.#syncInputState();
    this.#scheduleFit(true);
  }

  focus(): void {
    this.#syncInputState();
    if (this.#terminal && !this.#terminal.options.disableStdin) {
      this.#terminal.focus();
    }
  }

  setTheme(theme: ThemeMode): void {
    this.theme = theme;
    if (this.#terminal) {
      this.#terminal.options.theme = { ...TERMINAL_THEMES[theme] };
    }
  }

  hasLiveRuntime(): boolean {
    return this.#runtimeId !== null;
  }

  dispose(): void {
    this.#attached = false;
    if (this.#terminal) this.#terminal.options.disableStdin = true;
    this.#terminal?.textarea?.blur();
    this.#resizeObserver?.disconnect();
    this.#dimensionSubscription?.dispose();
    this.#visibilitySubscription?.dispose();
    this.#activeSubscription?.dispose();
    this.#dimensionSubscription = null;
    this.#visibilitySubscription = null;
    this.#activeSubscription = null;
    this.#panelApi = null;
    this.#resizeScheduler.clear();
    this.#fitFrameScheduler.clear();
    this.#fitSettler.cancel();
    this.#frameSwap.release();
    this.#pendingResize.clear();
    this.#repaintCapture?.cancel();
    this.#repaintCapture = null;
    this.#resizeOutputSettler?.cancel();
    this.#resizeOutputSettler = null;
    this.#releaseFitWaiters();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.dispose();
    this.#outputFrameScheduler.clear();
    this.#outputWriteInFlight = false;
    this.#releaseOutputWriteCredit();
    this.#dropOutputQueue();
    this.#unlisten?.();
    this.#unlisten = null;
    this.#inputFollowDispose?.();
    this.#inputFollowDispose = null;
    this.#resizeGestureDispose?.();
    this.#resizeGestureDispose = null;
    this.#terminal?.dispose();
    this.#terminal = null;
    delete (this.element as TerminalDebugElement).__CCSM_TERMINAL_DEBUG__;
  }

  #observeSize(): void {
    this.#resizeObserver?.disconnect();
    if (!this.#host) return;
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleFit());
    this.#resizeObserver.observe(this.#host);
  }

  #installResizeGestureGuard(): void {
    if (this.#resizeGestureDispose) return;
    const document = this.element.ownerDocument;
    const window = document.defaultView;
    if (!window) return;
    const begin = (event: Event) => {
      if (!isTerminalResizeHandle(event.target)) return;
      this.#fitSettler.beginResizeGesture();
    };
    const finish = () => this.#fitSettler.endResizeGesture();
    document.addEventListener("pointerdown", begin, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish);
    this.#resizeGestureDispose = () => {
      document.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish);
    };
  }

  #bindPanelEvents(api: GroupPanelPartInitParameters["api"]): void {
    this.#dimensionSubscription?.dispose();
    this.#visibilitySubscription?.dispose();
    this.#activeSubscription?.dispose();
    this.#dimensionSubscription = api.onDidDimensionsChange(() =>
      this.#scheduleFit(),
    );
    this.#visibilitySubscription = api.onDidVisibilityChange(
      ({ isVisible }) => {
        this.#syncInputState();
        if (isVisible) {
          this.#scheduleFit(true);
          void this.#maybeAutoStart();
        }
      },
    );
    this.#activeSubscription = api.onDidActiveChange(({ isActive }) => {
      this.#syncInputState();
      if (isActive) {
        this.#scheduleFit(true);
        void this.#maybeAutoStart();
      }
    });
  }

  #syncInputState(): void {
    if (!this.#terminal) return;
    const enabled = Boolean(this.#attached && this.#panelApi?.isVisible);
    this.#terminal.options.disableStdin = !enabled;
    if (!enabled) this.#terminal.textarea?.blur();
  }

  async #initialize(): Promise<void> {
    if (!this.#host) return;
    try {
      const ghostty = await loadIsolatedGhostty();
      if (this.#destroyed || !this.#host) return;
      this.#terminal = new Terminal({
        ghostty,
        cols: 80,
        rows: 24,
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        fontCellWidth: TERMINAL_FONT_CELL_WIDTH,
        fontCellHeight: TERMINAL_FONT_CELL_HEIGHT,
        disableStdin: true,
        scrollback: SCROLLBACK_BYTES,
        theme: { ...TERMINAL_THEMES[this.theme] },
        linkHandler: (uri) => {
          const target = classifyTerminalUri(uri);
          if (target) this.#openTerminalLink(target);
        },
      });
      this.#terminal.loadAddon(this.#fitAddon);
      this.#terminal.open(this.#host);
      this.#terminal.registerLinkProvider(
        new FilePathLinkProvider(this.#terminal, (reference) =>
          this.#openTerminalFile(reference),
        ),
      );
      this.#syncInputState();
      this.#inputFollowDispose = installCliInputFollow(
        this.#terminal,
        this.#host,
        () => this.#session?.provider ?? null,
      );
      this.#terminal.onData((data) => this.#enqueueInput(data));
      this.#terminal.attachCustomKeyEventHandler((event) => {
        const provider = this.#session?.provider ?? null;
        if (isAgentCliCopyShortcut(provider, event)) {
          this.#terminal?.copySelection();
          return true;
        }
        const data = cliShortcutInput(provider, event);
        if (data === null) return false;
        this.#terminal?.input(data, true);
        return true;
      });
      this.#terminal.onResize(({ cols, rows }) =>
        this.#scheduleResize(cols, rows),
      );
      this.#scheduleFit(true);
      if (this.#panelApi?.isVisible) await this.#waitForValidFit();
      const sessionId = this.#tab.resourceId;
      if (!sessionId) throw new Error("CLI Tab is missing resourceId");
      this.#session = await this.#client.backend.getCliSession(sessionId);
      this.element.dataset.provider = this.#session.provider;
      const attemptedStart = await this.#maybeAutoStart();
      if (!attemptedStart && !this.#starting && !this.#runtimeId)
        this.#renderRuntimeStatus();
    } catch (error) {
      this.#setStatus("error", `terminal error · ${describeError(error)}`);
    }
  }

  async #maybeAutoStart(): Promise<boolean> {
    const session = this.#session;
    if (!session || !this.#terminal || this.#starting || this.#runtimeId)
      return false;
    if (
      !shouldAutoStartCliRuntime(
        session,
        Boolean(this.#panelApi?.isVisible && this.#panelApi?.isActive),
        this.#manualStopBlocked,
      )
    )
      return false;
    if (this.#panelApi?.isVisible) await this.#waitForValidFit();
    await this.#start();
    return true;
  }

  async #start(): Promise<void> {
    if (this.#starting || this.#runtimeId || !this.#terminal) return;
    const sessionId = this.#session?.id ?? this.#tab.resourceId;
    if (!sessionId) throw new Error("CLI Tab is missing resourceId");
    this.#starting = true;
    this.#syncAction();
    this.#setStatus("starting", `starting ${this.#tab.title}`);
    try {
      await this.#inputQueue;
      if (!(await this.#waitForOutputDrain())) this.#dropOutputQueue();
      this.#pendingExitCode = null;
      this.#resetOnNextRuntimeOutput = true;
      const started = await this.#client.backend.startRuntime(
        {
          cliSessionId: sessionId,
          cols: this.#terminal.cols,
          rows: this.#terminal.rows,
        },
        (event) => this.#onRuntimeEvent(event),
      );
      if (!runtimeStartCanCommit(this.#exitedRuntimeIds, started.runtimeId)) {
        return;
      }
      this.#runtimeId = started.runtimeId;
      this.#backendSize = {
        cols: this.#terminal.cols,
        rows: this.#terminal.rows,
      };
      try {
        await this.#client.backend.resizeRuntime(
          started.runtimeId,
          this.#terminal.cols,
          this.#terminal.rows,
        );
      } catch (error) {
        this.#terminal.writeln(
          `\r\n\x1b[33m[initial resize failed: ${describeError(error)}]\x1b[0m`,
        );
      }
      if (this.#session) {
        this.#session.desiredState = "running";
        this.#session.nativeBindingState = started.nativeBindingState;
      }
      this.#meta!.textContent = `${started.shell} · pid ${started.pid ?? "—"}`;
      this.#renderRuntimeStatus();
      if (this.#panelApi) {
        focusWhenPanelActive(this.#panelApi, () => this.#terminal?.focus());
      }
    } catch (error) {
      this.#resetOnNextRuntimeOutput = false;
      this.#setStatus("error", `start failed · ${describeError(error)}`);
      this.#terminal.writeln(
        `\r\n\x1b[31m[start failed: ${describeError(error)}]\x1b[0m`,
      );
    } finally {
      this.#starting = false;
      this.#syncAction();
    }
  }

  #onRuntimeEvent(event: RuntimeEvent): void {
    if (this.#destroyed) return;
    if (event.type === "output") {
      if (this.#exitedRuntimeIds.has(event.runtimeId)) return;
      this.#lastOutputRuntimeId = event.runtimeId;
      if (this.#resetOnNextRuntimeOutput) {
        this.#resetOnNextRuntimeOutput = false;
        this.#oscStripper.reset();
        this.#terminal?.reset();
      }
      this.#runtimeId ??= event.runtimeId;
      const rawOutput = new Uint8Array(event.data);
      this.#resizeOutputSettler?.push(event.runtimeId, rawOutput);
      if (this.#repaintCapture?.push(event.runtimeId, rawOutput)) {
        this.#queueOutputAck(event.runtimeId, rawOutput.byteLength);
        return;
      }
      const output = this.#sanitizeTerminalOutput(rawOutput);
      if (output.byteLength === 0) {
        this.#queueOutputAck(event.runtimeId, rawOutput.byteLength);
        return;
      }
      this.#outputQueue.push({
        data: output,
        credit: { runtimeId: event.runtimeId, bytes: rawOutput.byteLength },
      });
      this.#scheduleOutputFlush();
      return;
    }
    if (event.type === "error") {
      this.#terminal?.writeln(
        `\r\n\x1b[31m[pty error: ${event.message}]\x1b[0m`,
      );
      return;
    }
    this.#resetOnNextRuntimeOutput = false;
    this.#exitedRuntimeIds.add(event.runtimeId);
    if (this.#repaintCapture?.runtimeId === event.runtimeId) {
      this.#repaintCapture.cancel();
      this.#repaintCapture = null;
    }
    if (this.#resizeOutputSettler?.runtimeId === event.runtimeId) {
      this.#resizeOutputSettler.cancel();
      this.#resizeOutputSettler = null;
    }
    this.#frameSwap.release();
    if (this.#runtimeId === event.runtimeId) {
      this.#runtimeId = null;
      this.#backendSize = null;
    }
    this.#pendingExitCode = event.code;
    this.#setStatus("stopped", `exit ${event.code}`);
    this.#syncAction();
    this.#scheduleOutputFlush();
    const sessionId = this.#tab.resourceId;
    if (sessionId) {
      void this.#client.backend
        .getCliSession(sessionId)
        .then((session) => {
          if (this.#destroyed) return;
          this.#session = session;
          this.#renderRuntimeStatus();
        })
        .catch((error) => {
          if (!this.#destroyed) {
            this.#setStatus(
              "error",
              `session refresh failed · ${describeError(error)}`,
            );
          }
        });
    }
  }

  #enqueueInput(data: string): void {
    if (!this.#runtimeId) return;
    const runtimeId = this.#runtimeId;
    this.#inputQueue = this.#inputQueue
      .then(() => this.#client.backend.writeRuntime(runtimeId, data))
      .catch((error) => {
        this.#terminal?.writeln(
          `\r\n\x1b[31m[input failed: ${describeError(error)}]\x1b[0m`,
        );
      });
  }

  #scheduleResize(cols: number, rows: number): void {
    if (!this.#runtimeId) return;
    this.#pendingResize.set({ cols, rows });
    if (this.#resizeInFlight) return;
    this.#resizeScheduler.enqueue("terminal-resize", () => {
      void this.#pumpResize();
    });
  }

  async #pumpResize(): Promise<void> {
    if (this.#resizeInFlight) return;
    this.#resizeInFlight = true;
    try {
      while (this.#runtimeId) {
        const size = this.#pendingResize.take();
        if (!size) break;
        const runtimeId = this.#runtimeId;
        try {
          await this.#applyRuntimeResize(runtimeId, size);
        } catch (error) {
          this.#setStatus("error", `resize failed · ${describeError(error)}`);
          break;
        }
        if (runtimeId !== this.#runtimeId) break;
      }
    } finally {
      this.#resizeInFlight = false;
      const next = this.#pendingResize.take();
      if (this.#runtimeId && next) {
        this.#pendingResize.set(next);
        void this.#pumpResize();
      }
    }
  }

  async #applyRuntimeResize(
    runtimeId: string,
    size: { cols: number; rows: number },
  ): Promise<void> {
    const outputSettler =
      shouldSettleResizePresentation(this.#session?.provider ?? null) &&
      this.#frameSwap.matches(size)
        ? new ResizeOutputSettler(
            runtimeId,
            TUI_REPAINT_QUIET_MS,
            TUI_REPAINT_TIMEOUT_MS,
          )
        : null;
    if (outputSettler) this.#resizeOutputSettler = outputSettler;
    try {
      if (this.#shouldRepaintClaudeHistory(runtimeId, size)) {
        await this.#repaintClaudeHistory(runtimeId, size);
        return;
      }
      await this.#client.backend.resizeRuntime(runtimeId, size.cols, size.rows);
      if (runtimeId === this.#runtimeId) this.#backendSize = { ...size };
      if (outputSettler) {
        outputSettler.startGracePeriod();
        const settled = await outputSettler.result;
        this.#lastResizePresentationCompletion = settled.completion;
        await this.#waitForOutputDrain();
        await waitForAnimationFrame();
        this.#resizePresentationCount += 1;
      }
    } finally {
      if (this.#resizeOutputSettler === outputSettler) {
        this.#resizeOutputSettler = null;
      }
      outputSettler?.cancel();
      if (this.#frameSwap.matches(size)) {
        if (
          this.#session?.provider === "claude" &&
          (this.#outputQueue.length > 0 || this.#outputWriteInFlight)
        ) {
          await this.#waitForOutputDrain();
        }
        this.#frameSwap.release();
      }
    }
  }

  #shouldRepaintClaudeHistory(
    runtimeId: string,
    size: { cols: number; rows: number },
  ): boolean {
    const terminal = this.#terminal;
    const previous = this.#backendSize;
    if (!terminal) return false;
    // Claude-only history repair: Shell, Codex, and Copilot keep normal VT reflow.
    return shouldRunClaudeHistoryRepaint({
      provider: this.#session?.provider ?? null,
      nativeBindingState: this.#session?.nativeBindingState ?? null,
      hasNativeSessionId: Boolean(this.#session?.nativeSessionId),
      runtimeMatches: runtimeId === this.#runtimeId,
      previousCols: previous?.cols ?? null,
      nextCols: size.cols,
      scrollbackLength: terminal.getScrollbackLength(),
      alternateScreen: Boolean(terminal.wasmTerm?.isAlternateScreen()),
      captureActive: Boolean(this.#repaintCapture),
    });
  }

  async #repaintClaudeHistory(
    runtimeId: string,
    size: { cols: number; rows: number },
  ): Promise<void> {
    const terminal = this.#terminal;
    if (!terminal) return;
    const expandedRows = calculateClaudeRepaintRows(
      terminal.getScrollbackLength(),
      size.rows,
    );
    if (!expandedRows || expandedRows <= size.rows) {
      await this.#client.backend.resizeRuntime(runtimeId, size.cols, size.rows);
      if (runtimeId === this.#runtimeId) this.#backendSize = { ...size };
      return;
    }

    const previousViewportY = terminal.getViewportY();
    const previousScrollbackLength = terminal.getScrollbackLength();
    const capture = new ClaudeRepaintCapture(runtimeId, expandedRows);
    this.#repaintCapture = capture;
    terminal.options.disableStdin = true;
    let expandedApplied = false;
    let restored = false;
    try {
      await this.#client.backend.resizeRuntime(
        runtimeId,
        size.cols,
        expandedRows,
      );
      expandedApplied = true;
      const captured = await capture.result;
      this.#lastRepaintCompletion = captured.completion;
      this.#lastRepaintSynchronizedEnds = captured.synchronizedEnds;
      const repaint =
        captured.repaint ??
        (captured.complete
          ? extractClaudeFullRepaint(captured.chunks, expandedRows)
          : null);
      if (
        repaint &&
        runtimeId === this.#runtimeId &&
        terminal.cols === size.cols &&
        terminal.rows === size.rows &&
        (await this.#waitForOutputDrain())
      ) {
        terminal.replaceBufferWithRepaint(repaint);
        terminal.scrollToLine(
          calculateRepaintViewportY(
            previousViewportY,
            previousScrollbackLength,
            terminal.getScrollbackLength(),
          ),
        );
        this.#historyRepaintCount += 1;
        if (
          captured.completion === "synchronized" ||
          captured.completion === "cursor"
        ) {
          this.#historyRepaintFastCount += 1;
        }
      } else {
        for (const chunk of captured.chunks) {
          this.#outputQueue.push({ data: chunk });
        }
        this.#scheduleOutputFlush();
        this.#historyRepaintFailureCount += 1;
      }

      if (runtimeId === this.#runtimeId) {
        await this.#client.backend.resizeRuntime(
          runtimeId,
          size.cols,
          size.rows,
        );
        restored = true;
        this.#backendSize = { ...size };
      }
    } finally {
      capture.cancel();
      if (this.#repaintCapture === capture) this.#repaintCapture = null;
      if (expandedApplied && !restored && runtimeId === this.#runtimeId) {
        try {
          await this.#client.backend.resizeRuntime(
            runtimeId,
            size.cols,
            size.rows,
          );
          this.#backendSize = { ...size };
        } catch {
          // The outer resize pump reports the original failure.
        }
      }
      this.#syncInputState();
    }
  }

  async #waitForOutputDrain(): Promise<boolean> {
    const deadline = performance.now() + OUTPUT_DRAIN_TIMEOUT_MS;
    while (
      (this.#outputQueue.length > 0 || this.#outputWriteInFlight) &&
      performance.now() < deadline
    ) {
      await waitForAnimationFrame();
    }
    return this.#outputQueue.length === 0 && !this.#outputWriteInFlight;
  }

  #scheduleOutputFlush(): void {
    if (this.#outputWriteInFlight || this.#destroyed) return;
    this.#outputFrameScheduler.enqueue("terminal-output", () => {
      if (this.#outputWriteInFlight || this.#destroyed) return;
      const batch = takeByteBatch(this.#outputQueue, OUTPUT_BUDGET_PER_FRAME);
      if (batch && this.#terminal) {
        this.#outputWriteInFlight = true;
        this.#outputWriteCredits = batch.credits;
        try {
          this.#terminal.write(batch.data, () => {
            this.#renderFailureCount = 0;
            this.#outputWriteInFlight = false;
            this.#releaseOutputWriteCredit();
            this.#scheduleOutputFlush();
          });
        } catch (error) {
          this.#outputWriteInFlight = false;
          this.#releaseOutputWriteCredit();
          this.#renderFailureCount += 1;
          this.#dropOutputQueue();
          if (this.#renderFailureCount >= 3)
            this.#setStatus(
              "error",
              `render degraded · ${describeError(error)}`,
            );
          else this.#renderRuntimeStatus();
        }
        return;
      }
      if (this.#outputQueue.length > 0) {
        this.#scheduleOutputFlush();
      } else if (this.#pendingExitCode !== null) {
        const code = this.#pendingExitCode;
        this.#pendingExitCode = null;
        this.#terminal?.writeln(
          `\r\n\x1b[2m[process exited · code ${code}]\x1b[0m`,
        );
      }
    });
  }

  #sanitizeTerminalOutput(output: Uint8Array): Uint8Array {
    if (this.#session?.provider !== "codex") return output;
    return this.#oscStripper.push(output);
  }

  #dropOutputQueue(): void {
    const credits = new Map<string, number>();
    for (const chunk of this.#outputQueue) {
      if (!chunk.credit) continue;
      credits.set(
        chunk.credit.runtimeId,
        (credits.get(chunk.credit.runtimeId) ?? 0) + chunk.credit.bytes,
      );
    }
    this.#outputQueue.length = 0;
    for (const [runtimeId, bytes] of credits) {
      this.#queueOutputAck(runtimeId, bytes);
    }
  }

  #releaseOutputWriteCredit(): void {
    const credits = this.#outputWriteCredits;
    this.#outputWriteCredits = [];
    for (const credit of credits) {
      this.#queueOutputAck(credit.runtimeId, credit.bytes);
    }
  }

  #queueOutputAck(runtimeId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.#pendingOutputAcks.set(
      runtimeId,
      (this.#pendingOutputAcks.get(runtimeId) ?? 0) + bytes,
    );
    if (!this.#outputAckInFlight) void this.#pumpOutputAcks();
  }

  async #pumpOutputAcks(): Promise<void> {
    if (this.#outputAckInFlight) return;
    this.#outputAckInFlight = true;
    try {
      while (this.#pendingOutputAcks.size > 0) {
        const pending = [...this.#pendingOutputAcks.entries()];
        this.#pendingOutputAcks.clear();
        for (const [runtimeId, bytes] of pending) {
          try {
            this.#outputAckBytesInFlight += bytes;
            await this.#client.backend.acknowledgeRuntimeOutput(
              runtimeId,
              bytes,
            );
          } catch {
            // Runtime exit closes the native flow gate and releases its credits.
          } finally {
            this.#outputAckBytesInFlight = Math.max(
              0,
              this.#outputAckBytesInFlight - bytes,
            );
          }
        }
      }
    } finally {
      this.#outputAckInFlight = false;
      if (this.#pendingOutputAcks.size > 0) void this.#pumpOutputAcks();
    }
  }

  #scheduleFit(immediate = false): void {
    if (!this.#attached || this.#destroyed || !this.#panelApi?.isVisible) {
      return;
    }
    this.element.dataset.resizePending = "true";
    this.#fitSettler.request(immediate);
  }

  #requestFitFrame(): void {
    if (!this.#attached || this.#destroyed || !this.#panelApi?.isVisible) {
      return;
    }
    this.#fitFrameScheduler.enqueue("terminal-fit", () => this.#fit(), true);
  }

  #fit(): boolean {
    const api = this.#panelApi;
    if (!this.#terminal || !this.#host?.isConnected || !api?.isVisible)
      return false;
    if (this.#fitSettler.gestureActive) return false;
    if (!isRenderableTerminalViewport(window.innerWidth, window.innerHeight)) {
      this.#fitSuppressedForTransientViewport = true;
      return false;
    }
    const groupRect = api.group.element.getBoundingClientRect();
    const panelRect = this.element.getBoundingClientRect();
    const dimensions = this.#fitAddon.proposeDimensions();
    if (
      !isDockGeometrySettled(
        { width: api.width, height: api.height },
        groupRect,
        panelRect,
      ) ||
      !dimensions
    ) {
      return false;
    }
    try {
      const redrawAfterSuppressedFit = this.#fitSuppressedForTransientViewport;
      const dimensionsChanged =
        dimensions.cols !== this.#terminal.cols ||
        dimensions.rows !== this.#terminal.rows;
      if (dimensionsChanged && this.#runtimeId && this.#host) {
        this.#frameSwap.capture(this.#terminal, this.#host, dimensions);
      }
      this.#fitAddon.fit();
      if (redrawAfterSuppressedFit) this.#terminal.redraw();
      this.#fitSuppressedForTransientViewport = false;
      this.#fitCount += 1;
      this.#hasValidFit = true;
      if (!dimensionsChanged || !this.#runtimeId) {
        this.#frameSwap.release();
      }
      this.#releaseFitWaiters();
      return true;
    } catch {
      // Dockview can briefly report zero geometry while moving a panel.
      this.#frameSwap.release();
      return false;
    }
  }

  #waitForValidFit(): Promise<void> {
    if (this.#hasValidFit || !this.#attached) return Promise.resolve();
    return new Promise((resolve) => this.#fitWaiters.add(resolve));
  }

  #releaseFitWaiters(): void {
    for (const resolve of this.#fitWaiters) resolve();
    this.#fitWaiters.clear();
  }

  async #handleAction(): Promise<void> {
    if (this.#runtimeId) {
      await this.#stop();
      return;
    }
    if (!this.#session) return;
    this.#manualStopBlocked = false;
    if (this.#session.nativeBindingState === "unavailable") {
      this.#setStatus("starting", "starting a new native Session");
      try {
        this.#session = await this.#client.backend.replaceCliSession({
          cliSessionId: this.#session.id,
        });
      } catch (error) {
        this.#setStatus("error", `replace failed · ${describeError(error)}`);
        return;
      }
    }
    await this.#start();
  }

  async #stop(): Promise<void> {
    if (!this.#runtimeId) return;
    const runtimeId = this.#runtimeId;
    this.#manualStopBlocked = true;
    this.#setStatus("stopping", "stopping");
    try {
      await this.#client.backend.stopRuntime(runtimeId);
      if (this.#session) this.#session.desiredState = "stopped";
    } catch (error) {
      this.#setStatus("error", `stop failed · ${describeError(error)}`);
    }
  }

  #renderRuntimeStatus(): void {
    const session = this.#session;
    if (this.#runtimeId) {
      const binding =
        session?.nativeBindingState === "pending"
          ? " · binding pending"
          : session?.nativeBindingState === "bound"
            ? " · resume ready"
            : "";
      this.#setStatus("running", `running${binding}`);
    } else if (session?.nativeBindingState === "unavailable") {
      this.#setStatus("error", "resume unavailable");
    } else {
      this.#setStatus("stopped", "stopped");
    }
    this.#syncAction();
  }

  #syncAction(): void {
    if (!this.#action) return;
    const running = Boolean(this.#runtimeId);
    const label = running
      ? "Stop"
      : this.#session?.nativeBindingState === "unavailable"
        ? "Start New"
        : "Start";
    this.#action.disabled = this.#starting;
    this.#action.classList.toggle("danger", running);
    this.#action.dataset.intent = running ? "stop" : "start";
    this.#action.title = label;
    this.#action.setAttribute("aria-label", label);
    const icon = this.#action.querySelector<HTMLElement>(".control-icon");
    const labelElement = this.#action.querySelector<HTMLElement>(
      ".terminal-action-label",
    );
    if (icon) icon.innerHTML = uiIcon(running ? "stop" : "play");
    if (labelElement) labelElement.textContent = label;
  }

  #setStatus(state: string, text: string): void {
    if (!this.#status) return;
    this.#status.dataset.state = state;
    this.#status.textContent = text;
  }

  #openTerminalFile(reference: TerminalFileReference): void {
    this.#openTerminalLink({ kind: "file", reference });
  }

  #openTerminalLink(target: TerminalLinkTarget): void {
    this.openLink({
      sourceTabId: this.#tab.id,
      spaceId: this.#tab.spaceId,
      target,
    });
  }

  #debugSnapshot(): object {
    const terminal = this.#terminal;
    const lines: string[] = [];
    if (terminal) {
      const buffer = terminal.buffer.active;
      const start = Math.max(0, buffer.length - 300);
      for (let index = start; index < buffer.length; index += 1) {
        const line = buffer.getLine(index)?.translateToString(true);
        if (line !== undefined) lines.push(line);
      }
    }
    return {
      cliSessionId: this.#tab.resourceId ?? null,
      runtimeId: this.#runtimeId,
      provider: this.#session?.provider ?? null,
      bindingState: this.#session?.nativeBindingState ?? null,
      nativeSessionId: this.#session?.nativeSessionId ?? null,
      cols: terminal?.cols ?? null,
      rows: terminal?.rows ?? null,
      bufferLength: terminal?.buffer.active.length ?? null,
      cellWidth: terminal?.renderer?.charWidth ?? null,
      cellHeight: terminal?.renderer?.charHeight ?? null,
      scrollbackLength: terminal?.getScrollbackLength() ?? null,
      viewportY: terminal?.getViewportY() ?? null,
      queuedOutputChunks: this.#outputQueue.length,
      queuedOutputBytes: this.#outputQueue.reduce(
        (total, chunk) => total + (chunk.credit?.bytes ?? 0),
        0,
      ),
      outputWriteCreditBytes: this.#outputWriteCredits.reduce(
        (total, credit) => total + credit.bytes,
        0,
      ),
      pendingOutputAckBytes:
        this.#outputAckBytesInFlight +
        [...this.#pendingOutputAcks.values()].reduce(
          (total, bytes) => total + bytes,
          0,
        ),
      fitCount: this.#fitCount,
      fitDebouncePending: this.#fitSettler.pending,
      resizeGestureActive: this.#fitSettler.gestureActive,
      resizePending: this.element.dataset.resizePending === "true",
      resizeSnapshotActive: this.#frameSwap.active,
      historyRepaintCount: this.#historyRepaintCount,
      historyRepaintFastCount: this.#historyRepaintFastCount,
      historyRepaintFailureCount: this.#historyRepaintFailureCount,
      lastRepaintCompletion: this.#lastRepaintCompletion,
      lastRepaintSynchronizedEnds: this.#lastRepaintSynchronizedEnds,
      resizeOutputWaitActive: Boolean(this.#resizeOutputSettler),
      resizePresentationCount: this.#resizePresentationCount,
      lastResizePresentationCompletion: this.#lastResizePresentationCompletion,
      repaintCaptureActive: Boolean(this.#repaintCapture),
      attached: this.#attached,
      inputEnabled: terminal ? !terminal.options.disableStdin : false,
      lastOutputRuntimeId: this.#lastOutputRuntimeId,
      mouseTracking: terminal?.hasMouseTracking() ?? false,
      mouseSgr: terminal?.getMode(1006) ?? false,
      lastMouseReport: terminal?.getLastMouseReport() ?? null,
      theme: this.theme,
      text: lines.join("\n"),
    };
  }
}

type TerminalDebugElement = HTMLElement & {
  __CCSM_TERMINAL_DEBUG__?: () => object;
};

export interface TerminalLinkOpenRequest {
  sourceTabId: string;
  spaceId: string;
  target: TerminalLinkTarget;
}

interface ClaudeRepaintCaptureResult {
  complete: boolean;
  completion: "synchronized" | "cursor" | "quiet" | "failed";
  chunks: Uint8Array[];
  repaint: Uint8Array | null;
  synchronizedEnds: number;
}

class ClaudeRepaintCapture {
  readonly chunks: Uint8Array[] = [];
  readonly result: Promise<ClaudeRepaintCaptureResult>;
  #resolve!: (result: ClaudeRepaintCaptureResult) => void;
  #quietTimer: number | null = null;
  #timeoutTimer: number | null = null;
  #byteLength = 0;
  #settled = false;
  #synchronizedEnds = 0;
  readonly #synchronizedEnd = new ChunkedByteSequenceMatcher(
    SYNCHRONIZED_UPDATE_END,
  );

  constructor(
    readonly runtimeId: string,
    private readonly expandedRows: number,
  ) {
    this.result = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    this.#timeoutTimer = window.setTimeout(
      () => this.#finish(false, "failed"),
      CLAUDE_REPAINT_TIMEOUT_MS,
    );
  }

  push(runtimeId: string, data: Uint8Array): boolean {
    if (this.#settled || runtimeId !== this.runtimeId) return false;
    this.#byteLength += data.byteLength;
    if (this.#byteLength > MAX_CLAUDE_REPAINT_BYTES) {
      this.chunks.push(data.slice());
      this.#finish(false, "failed");
      return true;
    }
    this.chunks.push(data.slice());
    if (this.#synchronizedEnd.push(data)) {
      this.#synchronizedEnds += 1;
      const repaint = extractClaudeSynchronizedRepaint(
        this.chunks,
        this.expandedRows,
      );
      if (repaint) {
        this.#finish(true, "synchronized", repaint);
        return true;
      }
    }
    if (data.at(-1) === 0x41) {
      const repaint = extractClaudeCursorPositionedRepaint(
        this.chunks,
        this.expandedRows,
      );
      if (repaint) {
        this.#finish(true, "cursor", repaint);
        return true;
      }
    }
    if (this.#quietTimer !== null) window.clearTimeout(this.#quietTimer);
    this.#quietTimer = window.setTimeout(
      () => this.#finish(true, "quiet"),
      CLAUDE_REPAINT_QUIET_MS,
    );
    return true;
  }

  cancel(): void {
    this.#finish(false, "failed");
  }

  #finish(
    complete: boolean,
    completion: ClaudeRepaintCaptureResult["completion"],
    repaint: Uint8Array | null = null,
  ): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#quietTimer !== null) window.clearTimeout(this.#quietTimer);
    if (this.#timeoutTimer !== null) window.clearTimeout(this.#timeoutTimer);
    this.#quietTimer = null;
    this.#timeoutTimer = null;
    this.#resolve({
      complete,
      completion,
      chunks: this.chunks,
      repaint,
      synchronizedEnds: this.#synchronizedEnds,
    });
  }
}
