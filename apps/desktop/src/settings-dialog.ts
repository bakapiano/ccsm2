import type { UpdateInfoDto } from "./generated/UpdateInfoDto";
import type { UpdateProgressDto } from "./generated/UpdateProgressDto";
import type { LinkOpeningController } from "./link-opening";
import type { ThemeController, ThemeMode } from "./theme";
import {
  describeError,
  type DesktopUpdateClient,
} from "./transport/desktop-client";

type UpdateViewState =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface SettingsDialogOptions {
  theme: ThemeController;
  linkOpening: LinkOpeningController;
  updates: DesktopUpdateClient;
  currentVersion: string;
  setModalVisible(visible: boolean): Promise<void> | void;
  prepareInstall(): Promise<boolean>;
  updateAvailabilityChanged?(available: boolean): void;
}

let settingsDialogSequence = 0;

export class SettingsDialog {
  readonly #dialogId = `settings-dialog-${++settingsDialogSequence}`;
  #backdrop: HTMLElement | null = null;
  #previouslyFocused: HTMLElement | null = null;
  #candidate: UpdateInfoDto | null = null;
  #progress: UpdateProgressDto | null = null;
  #state: UpdateViewState = "idle";
  #message = "";
  #checkPromise: Promise<UpdateInfoDto | null> | null = null;
  #installFlowActive = false;

  constructor(private readonly options: SettingsDialogOptions) {}

  async open(trigger?: HTMLElement): Promise<void> {
    if (this.#backdrop) {
      this.#backdrop
        .querySelector<HTMLElement>(".settings-dialog-close")
        ?.focus();
      return;
    }
    this.#previouslyFocused =
      trigger ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    await this.options.setModalVisible(true);
    const backdrop = document.createElement("div");
    backdrop.className = "settings-dialog-backdrop";
    backdrop.innerHTML = `
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="${this.#dialogId}-title">
        <header class="settings-dialog-head">
          <h2 id="${this.#dialogId}-title">Settings</h2>
          <button class="settings-dialog-close" type="button" aria-label="Close settings" title="Close">×</button>
        </header>
        <div class="settings-dialog-body">
          <section class="settings-section">
            <div class="settings-section-title">
              <h3>Appearance</h3>
              <p>Application and terminal colors.</p>
            </div>
            <div class="settings-section-content">
              <span class="settings-field-label" id="${this.#dialogId}-theme-label">Theme</span>
              <div class="settings-theme-options" role="radiogroup" aria-labelledby="${this.#dialogId}-theme-label">
                <button class="settings-theme-option" type="button" role="radio" data-theme-choice="light">Light</button>
                <button class="settings-theme-option" type="button" role="radio" data-theme-choice="dark">Dark</button>
              </div>
            </div>
          </section>
          <section class="settings-section">
            <div class="settings-section-title">
              <h3>Links</h3>
              <p>Choose where web links open.</p>
            </div>
            <div class="settings-section-content">
              <button class="settings-toggle" type="button" role="switch" aria-checked="false" data-settings-action="toggle-default-browser">
                <span class="settings-toggle-copy">
                  <strong>Open web links in default browser</strong>
                  <small>Use your operating system default browser for links opened from CCSM.</small>
                </span>
                <span class="settings-toggle-track" aria-hidden="true"><span></span></span>
              </button>
            </div>
          </section>
          <section class="settings-section">
            <div class="settings-section-title">
              <h3>Updates</h3>
              <p>Signed desktop releases.</p>
            </div>
            <div class="settings-section-content">
              <p class="settings-update-version">Current version ${escapeHtml(this.options.currentVersion)}</p>
              <p class="settings-update-status" role="status" aria-live="polite"></p>
              <p class="settings-update-source" hidden></p>
              <pre class="settings-release-notes" hidden></pre>
              <progress class="settings-update-progress" hidden></progress>
              <div class="settings-update-actions">
                <button type="button" data-settings-action="check">Check for updates</button>
                <button type="button" class="primary" data-settings-action="upgrade" hidden>Upgrade and restart</button>
              </div>
            </div>
          </section>
        </div>
        <footer class="settings-dialog-foot">
          <button type="button" data-settings-action="close">Close</button>
        </footer>
      </section>`;
    this.#backdrop = backdrop;
    for (const button of backdrop.querySelectorAll<HTMLButtonElement>(
      "[data-theme-choice]",
    )) {
      button.addEventListener("click", () => {
        this.options.theme.set(button.dataset.themeChoice as ThemeMode);
        this.#render();
      });
    }
    backdrop
      .querySelector<HTMLButtonElement>(
        '[data-settings-action="toggle-default-browser"]',
      )
      ?.addEventListener("click", () => {
        this.options.linkOpening.toggleOpenInDefaultBrowser();
        this.#render();
      });
    backdrop
      .querySelector<HTMLButtonElement>('[data-settings-action="check"]')
      ?.addEventListener("click", () => void this.checkForUpdates(true));
    backdrop
      .querySelector<HTMLButtonElement>('[data-settings-action="upgrade"]')
      ?.addEventListener("click", () => void this.#upgradeAndRestart());
    for (const close of backdrop.querySelectorAll<HTMLButtonElement>(
      '.settings-dialog-close, [data-settings-action="close"]',
    )) {
      close.addEventListener("click", () => void this.close());
    }
    document.body.append(backdrop);
    document.addEventListener("keydown", this.#onDocumentKeyDown, true);
    this.#render();
    backdrop.querySelector<HTMLElement>(".settings-dialog-close")?.focus();
  }

  async close(): Promise<void> {
    if (!this.#backdrop || this.#installFlowActive) return;
    const backdrop = this.#backdrop;
    this.#backdrop = null;
    document.removeEventListener("keydown", this.#onDocumentKeyDown, true);
    backdrop.remove();
    await this.options.setModalVisible(false);
    if (this.#previouslyFocused?.isConnected) this.#previouslyFocused.focus();
    this.#previouslyFocused = null;
  }

  destroy(): void {
    document.removeEventListener("keydown", this.#onDocumentKeyDown, true);
    this.#backdrop?.remove();
    this.#backdrop = null;
    void this.options.setModalVisible(false);
  }

  async checkForUpdates(interactive: boolean): Promise<UpdateInfoDto | null> {
    if (this.#checkPromise) return this.#checkPromise;
    const check = this.#performCheck(interactive);
    this.#checkPromise = check;
    try {
      return await check;
    } finally {
      this.#checkPromise = null;
    }
  }

  async #performCheck(interactive: boolean): Promise<UpdateInfoDto | null> {
    if (this.#installFlowActive) return this.#candidate;
    this.#state = "checking";
    this.#message = "Checking for updates…";
    this.#render();
    try {
      this.#candidate = await this.options.updates.check();
      this.#progress = null;
      if (this.#candidate) {
        this.#state = "available";
        this.#message = `Version ${this.#candidate.version} is available.`;
        this.options.updateAvailabilityChanged?.(true);
      } else {
        this.#state = "current";
        this.#message = "CCSM is up to date.";
        this.options.updateAvailabilityChanged?.(false);
      }
      return this.#candidate;
    } catch (error) {
      this.#state = interactive ? "error" : "idle";
      this.#message = interactive
        ? `Update check failed: ${describeError(error)}`
        : "";
      return null;
    } finally {
      this.#render();
    }
  }

  async #upgradeAndRestart(): Promise<void> {
    if (!this.#candidate || this.#installFlowActive) return;
    this.#installFlowActive = true;
    try {
      if (this.#state !== "ready") {
        this.#state = "downloading";
        this.#message = "Downloading signed update…";
        this.#progress = null;
        this.#render();
        await this.options.updates.download(this.#candidate.id, (progress) => {
          this.#progress = progress;
          this.#message = downloadMessage(progress);
          this.#render();
        });
      }
      this.#state = "ready";
      this.#message = "Update downloaded and verified.";
      this.#render();
      if (!(await this.options.prepareInstall())) return;
      this.#state = "installing";
      this.#message = "Installing update and restarting CCSM…";
      this.#render();
      await this.options.updates.install(this.#candidate.id);
    } catch (error) {
      this.#state = "error";
      this.#message = `Update failed: ${describeError(error)}`;
      this.#render();
    } finally {
      this.#installFlowActive = false;
      this.#render();
    }
  }

  #render(): void {
    const root = this.#backdrop;
    if (!root) return;
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-theme-choice]",
    )) {
      const selected =
        button.dataset.themeChoice === this.options.theme.current;
      button.setAttribute("aria-checked", String(selected));
    }
    requiredElement<HTMLButtonElement>(
      root,
      '[data-settings-action="toggle-default-browser"]',
    ).setAttribute(
      "aria-checked",
      String(this.options.linkOpening.openInDefaultBrowser),
    );
    const status = requiredElement<HTMLElement>(
      root,
      ".settings-update-status",
    );
    status.dataset.state = this.#state;
    status.textContent = this.#message;
    const source = requiredElement<HTMLElement>(
      root,
      ".settings-update-source",
    );
    source.hidden = !this.#candidate;
    source.textContent = this.#candidate
      ? `Source: ${this.#candidate.source}`
      : "";
    const notes = requiredElement<HTMLElement>(root, ".settings-release-notes");
    notes.hidden = !this.#candidate?.notes;
    notes.textContent = this.#candidate?.notes ?? "";
    const progress = requiredElement<HTMLProgressElement>(
      root,
      ".settings-update-progress",
    );
    progress.hidden = this.#state !== "downloading";
    if (this.#progress?.totalBytes != null) {
      progress.max = this.#progress.totalBytes;
      progress.value = this.#progress.downloadedBytes;
    } else {
      progress.removeAttribute("value");
    }
    const checking = this.#state === "checking";
    const checkButton = requiredElement<HTMLButtonElement>(
      root,
      '[data-settings-action="check"]',
    );
    checkButton.disabled = checking || this.#installFlowActive;
    checkButton.textContent = checking ? "Checking…" : "Check for updates";
    const upgradeButton = requiredElement<HTMLButtonElement>(
      root,
      '[data-settings-action="upgrade"]',
    );
    upgradeButton.hidden = !this.#candidate;
    upgradeButton.disabled = this.#installFlowActive;
    upgradeButton.textContent =
      this.#state === "ready" ? "Restart and install" : "Upgrade and restart";
    for (const close of root.querySelectorAll<HTMLButtonElement>(
      '.settings-dialog-close, [data-settings-action="close"]',
    )) {
      close.disabled = this.#installFlowActive;
    }
  }

  readonly #onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.#backdrop) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      this.#backdrop.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? current <= 0
        ? focusable.length - 1
        : current - 1
      : current < 0 || current === focusable.length - 1
        ? 0
        : current + 1;
    event.preventDefault();
    focusable[next]?.focus();
  };
}

function downloadMessage(progress: UpdateProgressDto): string {
  const downloaded = formatBytes(progress.downloadedBytes);
  const total =
    progress.totalBytes == null
      ? ""
      : ` of ${formatBytes(progress.totalBytes)}`;
  return `Downloading ${downloaded}${total} from ${progress.source}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing settings element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}
