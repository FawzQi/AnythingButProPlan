import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  DebugProgressEvent,
  DebugRunRequest,
  DebugRunResponse,
} from "@shared/types";
import {
  killDebugCommands,
  runDebugCommands,
} from "../../services/coding/debug-runner";
import { requireString } from "../validation";

export function registerDebugHandlers(): void {
  ipcMain.handle(
    IpcChannel.DebugRunCommands,
    async (event, request: unknown): Promise<DebugRunResponse> => {
      const typed = request as DebugRunRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const commands = Array.isArray(typed?.commands)
        ? typed.commands
            .map((c) => (typeof c === "string" ? c.trim() : ""))
            .filter(Boolean)
        : [];

      const sender = event.sender;
      const onProgress = (payload: DebugProgressEvent): void => {
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.DebugProgress, payload);
        }
      };

      return runDebugCommands(projectRoot, commands, onProgress);
    },
  );

  ipcMain.handle(
    IpcChannel.DebugKillCommands,
    async (): Promise<void> => {
      killDebugCommands();
    },
  );
}
