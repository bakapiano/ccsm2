export interface FileEditorDialogAction<T extends string> {
  id: T;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface FileEditorDialogOptions<T extends string> {
  title: string;
  message: string;
  files?: readonly string[];
  actions: readonly FileEditorDialogAction<T>[];
  cancelAction: T;
}

export function showFileEditorDialog<T extends string>(
  options: FileEditorDialogOptions<T>,
): Promise<T> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "file-editor-dialog-backdrop";
    const dialog = document.createElement("section");
    dialog.className = "file-editor-dialog";
    dialog.role = "dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "file-editor-dialog-title");
    const heading = document.createElement("h2");
    heading.id = "file-editor-dialog-title";
    heading.textContent = options.title;
    const message = document.createElement("p");
    message.textContent = options.message;
    dialog.append(heading, message);
    if (options.files?.length) {
      const list = document.createElement("ul");
      for (const file of options.files) {
        const item = document.createElement("li");
        item.textContent = file;
        list.append(item);
      }
      dialog.append(list);
    }
    const actions = document.createElement("div");
    actions.className = "file-editor-dialog-actions";
    let finished = false;
    const finish = (value: T) => {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(options.cancelAction);
    };
    for (const action of options.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.dialogAction = action.id;
      if (action.primary) button.classList.add("primary");
      if (action.danger) button.classList.add("danger");
      button.addEventListener("click", () => finish(action.id));
      actions.append(button);
    }
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener("keydown", onKeyDown, true);
    actions.querySelector<HTMLButtonElement>("button.primary, button")?.focus();
  });
}
