import { BrowserWindow, dialog, ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  DeleteFileRequest,
  DeleteFileResult,
  ScanResult,
  WriteFileRequest,
  WriteFileResult,
} from "@shared/types";
import {
  deleteFile,
  readTextFile,
  scanDirectory,
  writeFile,
} from "../../services/core/fs-service";
import { requireString } from "../validation";
import { openTerminalAt } from "../terminal";

export function registerFileHandlers(): void {
  ipcMain.handle(
    IpcChannel.PickDirectory,
    async (event): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ["openDirectory" as const] };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(
    IpcChannel.ScanDirectory,
    async (_event, root: unknown): Promise<ScanResult> => {
      return scanDirectory(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.ReadFile,
    async (_event, root: unknown, relativePath: unknown): Promise<string> => {
      return readTextFile(
        requireString(root, "root"),
        requireString(relativePath, "path"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.WriteFile,
    async (_event, request: unknown): Promise<WriteFileResult> => {
      const typed = request as WriteFileRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      const relativePath = requireString(typed?.path, "path");
      const content = typeof typed?.content === "string" ? typed.content : "";
      return writeFile(root, relativePath, content);
    },
  );

  ipcMain.handle(
    IpcChannel.DeleteFile,
    async (_event, request: unknown): Promise<DeleteFileResult> => {
      const typed = request as DeleteFileRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      const relativePath = requireString(typed?.path, "path");
      return deleteFile(root, relativePath);
    },
  );

  ipcMain.handle(
    IpcChannel.OpenTerminal,
    async (_event, root: unknown): Promise<void> => {
      openTerminalAt(requireString(root, "root"));
    },
  );
}
