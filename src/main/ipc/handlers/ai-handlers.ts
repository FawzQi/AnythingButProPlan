import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type { AiSuggestRequest, AiSuggestion } from "@shared/types";
import { discoverModels } from "../../services/ai/ai-providers";
import { getApiKey, getSettings } from "../../services/core/settings";
import { measureMapTokens } from "../../services/coding/file-selector";
import {
  suggestFilesGitNexusJev,
  suggestFilesGitNexusLlm,
  suggestFilesGitNexusOnly,
} from "../../services/git/gitnexus-selector";
import { requireString } from "../validation";

export function registerAiHandlers(): void {
  ipcMain.handle(
    IpcChannel.AiListModels,
    async (_event, provider: unknown): Promise<string[]> => {
      const id = provider;
      if (
        id !== "deepseek" &&
        id !== "groq" &&
        id !== "openrouter" &&
        id !== "google"
      ) {
        throw new Error(`Unknown AI provider: ${String(id)}`);
      }
      const apiKey = await getApiKey(id);
      if (!apiKey) {
        throw new Error(
          "No API key saved for this provider. Paste a key and save it first.",
        );
      }
      return discoverModels(id, apiKey);
    },
  );

  ipcMain.handle(
    IpcChannel.AiSuggestFiles,
    async (_event, request: unknown): Promise<AiSuggestion> => {
      const typed = request as AiSuggestRequest;
      const settings = await getSettings();
      if (!Array.isArray(typed?.filePaths)) {
        throw new Error("Invalid filePaths: expected an array.");
      }
      const normalised: AiSuggestRequest = {
        projectRoot: requireString(typed?.projectRoot, "projectRoot"),
        filePaths: typed.filePaths.map((p) => requireString(p, "file path")),
        instruction:
          typeof typed?.instruction === "string" ? typed.instruction : "",
        dryRun: typed?.dryRun,
      };
      if (normalised.dryRun) {
        return measureMapTokens(normalised);
      }
      const method = settings.suggestMethod ?? "gitnexus-only";
      if (method === "gitnexus-only") {
        return suggestFilesGitNexusOnly(
          normalised,
          settings.provider ?? "deepseek",
        );
      }
      if (method === "gitnexus-jev") {
        return suggestFilesGitNexusJev(normalised);
      }
      if (method === "gitnexus-llm") {
        return suggestFilesGitNexusLlm(
          normalised,
          settings.provider ?? "deepseek",
        );
      }
      throw new Error(`Unknown suggestion method: ${String(method)}`);
    },
  );
}
