import { type AppDialogAction, showAppDialog } from "./app-dialog";

export type FileEditorDialogAction<T extends string> = AppDialogAction<T>;

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
  return showAppDialog({
    title: options.title,
    message: options.message,
    details: options.files,
    actions: options.actions,
    cancelAction: options.cancelAction,
  }).then((result) => result.action);
}
