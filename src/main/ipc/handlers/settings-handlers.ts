import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  AiSettings,
  AiSettingsSaveRequest,
  RecentFolder,
} from "@shared/types";
import { listProviders } from "../../services/ai/ai-providers";
import { getSettings, saveSettings } from "../../services/core/settings";
import {
  addRecentFolder,
  clearRecentFolders,
  listRecentFolders,
  removeRecentFolder,
} from "../../services/core/recent-folders";
import { requireString } from "../validation";

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    IpcChannel.RecentFoldersList,
    async (): Promise<RecentFolder[]> => {
      return listRecentFolders();
    },
  );

  ipcMain.handle(
    IpcChannel.RecentFoldersAdd,
    async (_event, folderPath: unknown): Promise<RecentFolder[]> => {
      return addRecentFolder(requireString(folderPath, "path"));
    },
  );

  ipcMain.handle(
    IpcChannel.RecentFoldersRemove,
    async (_event, folderPath: unknown): Promise<RecentFolder[]> => {
      return removeRecentFolder(requireString(folderPath, "path"));
    },
  );

  ipcMain.handle(
    IpcChannel.RecentFoldersClear,
    async (): Promise<RecentFolder[]> => {
      return clearRecentFolders();
    },
  );

  ipcMain.handle(
    IpcChannel.AiSettingsGet,
    async (): Promise<{
      settings: AiSettings;
      providers: ReturnType<typeof listProviders>;
    }> => {
      return {
        settings: await getSettings(),
        providers: listProviders(),
      };
    },
  );

  ipcMain.handle(
    IpcChannel.AiSettingsSave,
    async (_event, request: unknown): Promise<AiSettings> => {
      const typed = request as AiSettingsSaveRequest;
      return saveSettings({
        provider: typed?.provider,
        model: typed?.model,
        apiKey: typed?.apiKey,
        suggestMethod: typed?.suggestMethod,
        mode: typed?.mode,
        enableHydeQuery: typed?.enableHydeQuery,
        hydeProvider: typed?.hydeProvider,
        hydeModel: typed?.hydeModel,
      });
    },
  );
}
