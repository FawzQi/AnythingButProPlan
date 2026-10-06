import { BrowserWindow, dialog, ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type { ConfirmDialogRequest } from "@shared/types";
import { requireString } from "../validation";

export function registerDialogHandlers(): void {
  ipcMain.handle(
    IpcChannel.ConfirmDialog,
    async (event, request: unknown): Promise<boolean> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const typed = request as ConfirmDialogRequest;
      const tone = typed?.tone ?? "question";
      const type =
        tone === "danger" || tone === "warning"
          ? ("warning" as const)
          : tone === "info"
            ? ("info" as const)
            : ("question" as const);
      const options = {
        type,
        buttons: [typed?.cancelLabel ?? "Cancel", typed?.confirmLabel ?? "OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: requireString(typed?.message, "message"),
        detail: typeof typed?.detail === "string" ? typed.detail : undefined,
      };
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    },
  );
}
