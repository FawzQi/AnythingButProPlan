import { BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { countTokens } from "gpt-tokenizer";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  ApplyFileInput,
  ApplyRequest,
  ApplyResult,
  DiffRequest,
  DiffResult,
  ParseResult,
  PromptBuildRequest,
  PromptBuildResult,
} from "@shared/types";
import { buildPrompt } from "../../services/coding/prompt-builder";
import { parseResponse } from "../../services/coding/response-parser";
import { applyFiles, computeDiff } from "../../services/coding/apply-engine";
import { writeFileEnsuringDir } from "../../services/core/fs-service";
import { requireString } from "../validation";

export function registerPromptHandlers(): void {
  ipcMain.handle(
    IpcChannel.BuildPrompt,
    async (_event, request: unknown): Promise<PromptBuildResult> => {
      const typed = request as PromptBuildRequest;
      if (!Array.isArray(typed?.files))
        throw new Error("Invalid files: expected an array.");
      const root =
        typeof typed?.projectRoot === "string" ? typed.projectRoot : "";
      if (typed.files.length > 0 && root === "") {
        throw new Error(
          "Invalid projectRoot: required when files are selected.",
        );
      }
      return buildPrompt(
        root,
        typed.files.map((file) => requireString(file, "file path")),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.CountTokens,
    async (_event, text: unknown): Promise<number> => {
      return countTokens(typeof text === "string" ? text : "");
    },
  );

  ipcMain.handle(
    IpcChannel.DiffFile,
    async (_event, request: unknown): Promise<DiffResult> => {
      const typed = request as DiffRequest;
      return computeDiff(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
        typeof typed?.content === "string" ? typed.content : "",
      );
    },
  );

  ipcMain.handle(
    IpcChannel.ApplyFiles,
    async (_event, request: unknown): Promise<ApplyResult[]> => {
      const typed = request as ApplyRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      if (!Array.isArray(typed?.files))
        throw new Error("Invalid files: expected an array.");
      return applyFiles({
        projectRoot: root,
        files: typed.files.map((file): ApplyFileInput => {
          const entry: ApplyFileInput = {
            path: requireString(file?.path, "path"),
            content: typeof file?.content === "string" ? file.content : "",
          };
          if (Array.isArray(file?.patches)) {
            entry.patches = file.patches
              .filter(
                (
                  patch: unknown,
                ): patch is { search: string; replace: string } => {
                  return (
                    typeof patch === "object" &&
                    patch !== null &&
                    typeof (patch as { search?: unknown }).search ===
                      "string" &&
                    typeof (patch as { replace?: unknown }).replace === "string"
                  );
                },
              )
              .map((patch) => ({
                search: patch.search,
                replace: patch.replace,
              }));
          }
          if (file?.delete === true) {
            entry.delete = true;
          }
          return entry;
        }),
      });
    },
  );

  ipcMain.handle(
    IpcChannel.SavePrompt,
    async (
      event,
      content: unknown,
      suggestedName: unknown,
    ): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = {
        defaultPath:
          typeof suggestedName === "string" ? suggestedName : "prompt.md",
        filters: [{ name: "Markdown", extensions: ["md", "txt"] }],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await writeFileEnsuringDir(
        result.filePath,
        requireString(content, "content"),
      );
      return result.filePath;
    },
  );

  ipcMain.handle(
    IpcChannel.CopyText,
    async (_event, text: unknown): Promise<void> => {
      clipboard.writeText(requireString(text, "text"));
    },
  );

  ipcMain.handle(
    IpcChannel.ParseResponse,
    async (_event, raw: unknown): Promise<ParseResult> => {
      return parseResponse(typeof raw === "string" ? raw : "");
    },
  );
}
