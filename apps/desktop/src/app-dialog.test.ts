import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { showAppDialog } from "./app-dialog";
import { agentCliTabCloseDialogOptions } from "./cli-tab-close-dialog";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

describe("application dialogs", () => {
  test("uses a styled text field and validates required input", async () => {
    const resultPromise = showAppDialog({
      title: "Rename Space",
      input: {
        label: "Space name",
        value: "Existing",
        required: true,
        maxLength: 10,
        selectOnOpen: true,
      },
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "submit", label: "Rename", primary: true },
      ] as const,
      cancelAction: "cancel" as const,
      submitAction: "submit" as const,
    });

    const form = requiredElement<HTMLFormElement>(".app-dialog");
    const input = requiredElement<HTMLInputElement>(".app-dialog-field input");
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(10);
    input.value = "   ";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".app-dialog-backdrop")).not.toBeNull();

    input.value = "This name is too long";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".app-dialog-field-error")?.textContent).toBe(
      "Space name cannot exceed 10 characters.",
    );

    input.value = "Renamed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );

    await expect(resultPromise).resolves.toEqual({
      action: "submit",
      inputValue: "Renamed",
    });
    expect(document.querySelector(".app-dialog-backdrop")).toBeNull();
  });

  test("cancels with Escape and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const resultPromise = showAppDialog({
      title: "Delete Space?",
      message: "This action deletes CCSM data.",
      actions: [
        { id: "cancel", label: "Cancel", autofocus: true },
        { id: "delete", label: "Delete", danger: true },
      ] as const,
      cancelAction: "cancel" as const,
      role: "alertdialog",
      tone: "danger",
    });

    expect(document.activeElement?.textContent).toBe("Cancel");
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect(resultPromise).resolves.toEqual({
      action: "cancel",
      inputValue: null,
    });
    expect(document.activeElement).toBe(trigger);
  });

  test("warns that closing an Agent CLI Tab deletes its database records", () => {
    const options = agentCliTabCloseDialogOptions({ title: "Codex" });

    expect(options.title).toContain("Codex");
    expect(options.message).toContain("stops its process tree");
    expect(options.message).toContain("data.db");
    expect(options.message).toContain("provider transcripts are preserved");
    expect(options.actions).toContainEqual({
      id: "cancel",
      label: "Cancel",
      autofocus: true,
    });
    expect(options.actions).toContainEqual({
      id: "close",
      label: "Close and Delete",
      danger: true,
    });
  });

  test("production TypeScript does not call browser-native dialogs", async () => {
    const sourceFiles = new Bun.Glob("**/*.ts").scanSync({
      cwd: import.meta.dir,
      onlyFiles: true,
    });
    const nativeDialogCall =
      /(?:\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)|(?<![\w.#])(?:alert|confirm|prompt))\s*\(/;
    const offenders: string[] = [];
    for (const relativePath of sourceFiles) {
      if (relativePath.endsWith(".test.ts")) continue;
      const source = await Bun.file(
        `${import.meta.dir}/${relativePath}`,
      ).text();
      if (nativeDialogCall.test(source)) offenders.push(relativePath);
    }
    expect(offenders).toEqual([]);
  });
});

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
