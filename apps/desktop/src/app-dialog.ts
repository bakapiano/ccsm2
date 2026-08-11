export interface AppDialogAction<T extends string> {
  id: T;
  label: string;
  primary?: boolean;
  danger?: boolean;
  autofocus?: boolean;
}

export interface AppDialogTextInput {
  label: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  emptyMessage?: string;
  maxLength?: number;
  tooLongMessage?: string;
  selectOnOpen?: boolean;
}

export interface AppDialogOptions<T extends string> {
  title: string;
  message?: string;
  details?: readonly string[];
  input?: AppDialogTextInput;
  actions: readonly AppDialogAction<T>[];
  cancelAction: T;
  submitAction?: T;
  role?: "dialog" | "alertdialog";
  tone?: "default" | "danger";
}

export interface AppDialogResult<T extends string> {
  action: T;
  inputValue: string | null;
}

let dialogSequence = 0;

export function showAppDialog<T extends string>(
  options: AppDialogOptions<T>,
): Promise<AppDialogResult<T>> {
  return new Promise((resolve) => {
    const dialogId = `app-dialog-${++dialogSequence}`;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    const form = document.createElement("form");
    form.className = "app-dialog";
    form.dataset.tone = options.tone ?? "default";
    form.setAttribute("role", options.role ?? "dialog");
    form.setAttribute("aria-modal", "true");
    form.setAttribute("aria-labelledby", `${dialogId}-title`);

    const header = document.createElement("header");
    header.className = "app-dialog-head";
    const heading = document.createElement("h2");
    heading.id = `${dialogId}-title`;
    heading.textContent = options.title;
    header.append(heading);
    form.append(header);

    const body = document.createElement("div");
    body.className = "app-dialog-body";
    if (options.message) {
      const message = document.createElement("p");
      message.id = `${dialogId}-message`;
      message.textContent = options.message;
      form.setAttribute("aria-describedby", message.id);
      body.append(message);
    }
    if (options.details?.length) {
      const list = document.createElement("ul");
      for (const detail of options.details) {
        const item = document.createElement("li");
        item.textContent = detail;
        list.append(item);
      }
      body.append(list);
    }

    let input: HTMLInputElement | null = null;
    let inputError: HTMLElement | null = null;
    if (options.input) {
      const field = document.createElement("div");
      field.className = "app-dialog-field";
      const label = document.createElement("label");
      label.htmlFor = `${dialogId}-input`;
      label.textContent = options.input.label;
      input = document.createElement("input");
      input.id = label.htmlFor;
      input.type = "text";
      input.value = options.input.value ?? "";
      input.placeholder = options.input.placeholder ?? "";
      input.autocomplete = "off";
      input.spellcheck = false;
      if (options.input.maxLength !== undefined)
        input.maxLength = options.input.maxLength;
      inputError = document.createElement("div");
      inputError.className = "app-dialog-field-error";
      inputError.id = `${dialogId}-input-error`;
      inputError.setAttribute("role", "status");
      inputError.setAttribute("aria-live", "polite");
      input.setAttribute("aria-describedby", inputError.id);
      input.addEventListener("input", () => {
        input?.removeAttribute("aria-invalid");
        if (inputError) inputError.textContent = "";
      });
      field.append(label, input, inputError);
      body.append(field);
    }
    form.append(body);

    const actions = document.createElement("footer");
    actions.className = "app-dialog-actions";
    let finished = false;
    const finish = (action: T): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      backdrop.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve({ action, inputValue: input?.value ?? null });
    };
    const validateInput = (): boolean => {
      if (!input || !options.input) return true;
      const value = input.value.trim();
      let error: string | null = null;
      if (options.input.required && !value) {
        error =
          options.input.emptyMessage ?? `${options.input.label} is required.`;
      } else if (
        options.input.maxLength !== undefined &&
        Array.from(value).length > options.input.maxLength
      ) {
        error =
          options.input.tooLongMessage ??
          `${options.input.label} cannot exceed ${options.input.maxLength} characters.`;
      }
      if (!error) return true;
      input.setAttribute("aria-invalid", "true");
      if (inputError) inputError.textContent = error;
      input.focus();
      return false;
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (options.submitAction === undefined || !validateInput()) return;
      finish(options.submitAction);
    });
    for (const action of options.actions) {
      const button = document.createElement("button");
      button.type = action.id === options.submitAction ? "submit" : "button";
      button.textContent = action.label;
      button.dataset.dialogAction = action.id;
      if (action.primary) button.classList.add("primary");
      if (action.danger) button.classList.add("danger");
      if (action.autofocus) button.dataset.autofocus = "true";
      if (button.type === "button") {
        button.addEventListener("click", () => finish(action.id));
      }
      actions.append(button);
    }
    form.append(actions);
    backdrop.append(form);

    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(options.cancelAction);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        form.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };

    document.body.append(backdrop);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    if (input) {
      input.focus();
      if (options.input?.selectOnOpen) input.select();
    } else {
      (
        actions.querySelector<HTMLElement>('[data-autofocus="true"]') ??
        actions.querySelector<HTMLElement>("button.primary, button")
      )?.focus();
    }
  });
}
