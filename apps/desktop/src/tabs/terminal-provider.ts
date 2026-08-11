import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { CliSessionDto } from "../generated/CliSessionDto";
import type { RuntimeEvent } from "../generated/RuntimeEvent";
import type { TabDto } from "../generated/TabDto";
import { focusWhenPanelActive } from "../panel-visibility";
import { RetainedRendererCache } from "../retained-renderer-cache";
import {
  DebouncedTask,
  LatestValue,
  OscSequenceStripper,
  runtimeStartCanCommit,
  shouldAutoStartCliRuntime,
  takeByteBatch,
} from "../terminal-flow";
import { isDockGeometrySettled } from "../terminal-layout";
import { TERMINAL_THEMES, type ThemeMode } from "../theme";
import type { CcsmDesktopClient } from "../transport/desktop-client";
import { describeError } from "../transport/desktop-client";
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

const SCROLLBACK_LINES = 800;
const OUTPUT_BUDGET_PER_FRAME = 8 * 1024;
const FIT_DEBOUNCE_MS = 80;

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
  ) {}

  createRenderer(tab: TabDto): IContentRenderer {
    return this.#renderers.getOrCreate(
      tab.id,
      () => new TerminalPanel(tab, this.client, this.theme),
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
  #resizeRaf = 0;
  #fitRaf = 0;
  readonly #fitDebounce = new DebouncedTask(FIT_DEBOUNCE_MS);
  #fitCount = 0;
  #hasValidFit = false;
  readonly #fitWaiters = new Set<() => void>();
  #resizeInFlight = false;
  readonly #pendingResize = new LatestValue<{ cols: number; rows: number }>();
  readonly #outputQueue: Uint8Array[] = [];
  readonly #oscStripper = new OscSequenceStripper();
  #outputRaf = 0;
  #outputWriteInFlight = false;
  #renderFailureCount = 0;
  #pendingExitCode: number | null = null;
  readonly #exitedRuntimeIds = new Set<string>();
  #inputQueue: Promise<void> = Promise.resolve();
  #unlisten: (() => void) | null = null;

  constructor(
    tab: TabDto,
    client: CcsmDesktopClient,
    private theme: ThemeMode,
  ) {
    this.#tab = tab;
    this.#client = client;
    this.element.className = "terminal-panel";
    this.element.dataset.cliSessionId = tab.resourceId ?? "";
    (this.element as TerminalDebugElement).__CCSM_TERMINAL_DEBUG__ = () =>
      this.#debugSnapshot();
    this.element.innerHTML = `
      <div class="terminal-host" aria-label="Terminal"></div>
      <div class="terminal-panel-toolbar">
        <span class="terminal-status" data-state="starting">loading terminal</span>
        <span class="terminal-meta">—</span>
        <button class="terminal-action" type="button">Stop</button>
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
    if (this.#resizeRaf) cancelAnimationFrame(this.#resizeRaf);
    if (this.#fitRaf) cancelAnimationFrame(this.#fitRaf);
    this.#fitDebounce.cancel();
    this.#resizeRaf = 0;
    this.#fitRaf = 0;
    this.#pendingResize.clear();
    this.#releaseFitWaiters();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.dispose();
    if (this.#outputRaf) cancelAnimationFrame(this.#outputRaf);
    this.#outputRaf = 0;
    this.#outputWriteInFlight = false;
    this.#outputQueue.length = 0;
    this.#unlisten?.();
    this.#unlisten = null;
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
        scrollback: SCROLLBACK_LINES,
        theme: { ...TERMINAL_THEMES[this.theme] },
      });
      this.#terminal.loadAddon(this.#fitAddon);
      this.#terminal.open(this.#host);
      this.#syncInputState();
      this.#terminal.onData((data) => this.#enqueueInput(data));
      this.#terminal.onResize(({ cols, rows }) =>
        this.#scheduleResize(cols, rows),
      );
      this.#scheduleFit(true);
      if (this.#panelApi?.isVisible) await this.#waitForValidFit();
      const sessionId = this.#tab.resourceId;
      if (!sessionId) throw new Error("CLI Tab is missing resourceId");
      this.#session = await this.#client.backend.getCliSession(sessionId);
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
      this.#runtimeId ??= event.runtimeId;
      const output = this.#sanitizeTerminalOutput(new Uint8Array(event.data));
      this.#outputQueue.push(output);
      this.#scheduleOutputFlush();
      return;
    }
    if (event.type === "error") {
      this.#terminal?.writeln(
        `\r\n\x1b[31m[pty error: ${event.message}]\x1b[0m`,
      );
      return;
    }
    this.#exitedRuntimeIds.add(event.runtimeId);
    if (this.#runtimeId === event.runtimeId) this.#runtimeId = null;
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
    if (this.#resizeInFlight || this.#resizeRaf) return;
    this.#resizeRaf = requestAnimationFrame(() => {
      this.#resizeRaf = 0;
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
          await this.#client.backend.resizeRuntime(
            runtimeId,
            size.cols,
            size.rows,
          );
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

  #scheduleOutputFlush(): void {
    if (this.#outputRaf || this.#outputWriteInFlight || this.#destroyed) return;
    this.#outputRaf = requestAnimationFrame(() => {
      this.#outputRaf = 0;
      const batch = takeByteBatch(this.#outputQueue, OUTPUT_BUDGET_PER_FRAME);
      if (batch && this.#terminal) {
        this.#outputWriteInFlight = true;
        try {
          this.#terminal.write(batch, () => {
            this.#renderFailureCount = 0;
            this.#outputWriteInFlight = false;
            this.#scheduleOutputFlush();
          });
        } catch (error) {
          this.#outputWriteInFlight = false;
          this.#renderFailureCount += 1;
          this.#outputQueue.length = 0;
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

  #scheduleFit(immediate = false): void {
    if (!this.#attached || this.#destroyed || !this.#panelApi?.isVisible) {
      return;
    }
    if (immediate) {
      this.#fitDebounce.cancel();
      this.#requestFitFrame();
      return;
    }
    this.#fitDebounce.schedule(() => this.#requestFitFrame());
  }

  #requestFitFrame(): void {
    if (
      !this.#attached ||
      this.#destroyed ||
      !this.#panelApi?.isVisible ||
      this.#fitRaf
    ) {
      return;
    }
    this.#fitRaf = requestAnimationFrame(() => {
      this.#fitRaf = 0;
      this.#fit();
    });
  }

  #fit(): boolean {
    const api = this.#panelApi;
    if (!this.#terminal || !this.#host?.isConnected || !api?.isVisible)
      return false;
    const groupRect = api.group.element.getBoundingClientRect();
    const panelRect = this.element.getBoundingClientRect();
    if (
      !isDockGeometrySettled(
        { width: api.width, height: api.height },
        groupRect,
        panelRect,
      ) ||
      !this.#fitAddon.proposeDimensions()
    ) {
      return false;
    }
    try {
      this.#fitAddon.fit();
      this.#fitCount += 1;
      this.#hasValidFit = true;
      this.#releaseFitWaiters();
      return true;
    } catch {
      // Dockview can briefly report zero geometry while moving a panel.
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
    this.#action.disabled = this.#starting;
    this.#action.classList.toggle("danger", Boolean(this.#runtimeId));
    this.#action.textContent = this.#runtimeId
      ? "Stop"
      : this.#session?.nativeBindingState === "unavailable"
        ? "Start New"
        : "Start";
  }

  #setStatus(state: string, text: string): void {
    if (!this.#status) return;
    this.#status.dataset.state = state;
    this.#status.textContent = text;
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
      scrollbackLength: terminal?.getScrollbackLength() ?? null,
      viewportY: terminal?.getViewportY() ?? null,
      queuedOutputChunks: this.#outputQueue.length,
      fitCount: this.#fitCount,
      fitDebouncePending: this.#fitDebounce.pending,
      attached: this.#attached,
      inputEnabled: terminal ? !terminal.options.disableStdin : false,
      theme: this.theme,
      text: lines.join("\n"),
    };
  }
}

type TerminalDebugElement = HTMLElement & {
  __CCSM_TERMINAL_DEBUG__?: () => object;
};
