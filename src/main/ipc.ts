import { spawn } from "node:child_process";
import { BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { countTokens } from "gpt-tokenizer";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  AiSettings,
  AiSettingsSaveRequest,
  AiSuggestion,
  AiSuggestRequest,
  ApplyFileInput,
  ApplyRequest,
  ApplyResult,
  ConfirmDialogRequest,
  DeleteFileRequest,
  DeleteFileResult,
  DiffRequest,
  DiffResult,
  GitCommitRequest,
  GitCommitResult,
  GitDiffContent,
  GitDiffRequest,
  GitDiscardRequest,
  GitInitRequest,
  GitInitResult,
  GitStageRequest,
  GitStatus,
  GitUnstageRequest,
  ParseResult,
  PromptBuildRequest,
  PromptBuildResult,
  ScanResult,
  WriteFileRequest,
  WriteFileResult,
} from "@shared/types";
import {
  scanDirectory,
  readTextFile,
  writeFileEnsuringDir,
  writeFile,
  deleteFile,
} from "./services/fs-service";
import {
  commitChanges,
  discardAllFiles,
  discardFile,
  getDiffContent,
  getStatus,
  initRepository,
  stageAllFiles,
  stageFile,
  unstageFile,
} from "./services/git-service";
import { buildPrompt } from "./services/prompt-builder";
import { applyFiles, computeDiff } from "./services/apply-engine";
import { parseResponse } from "./services/response-parser";
import { getApiKey, getSettings, saveSettings } from "./services/settings";
import { suggestFiles } from "./services/file-selector";
import {
  suggestFilesGitNexus,
  suggestFilesGitNexusOnly,
} from "./services/gitnexus-selector";
import { discoverModels, listProviders } from "./services/ai-providers";

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
  return value;
}

/**
 * Launch the platform's terminal emulator in `cwd`. Detached + unref so the
 * child outlives this process — a terminal the user opened should stay open
 * after the app quits.
 */
function openTerminalAt(cwd: string): void {
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === "win32") {
    // `start` needs an explicit title argument, else a quoted first argument
    // is interpreted as the window title instead of the program.
    command = "cmd";
    args = ["/c", "start", "", "cmd", "/K", `cd /d "${cwd}"`];
  } else if (platform === "darwin") {
    command = "open";
    args = ["-a", "Terminal", cwd];
  } else {
    // Linux/BSD: x-terminal-emulator is the Debian alternatives entry point
    // and is present on most desktops that ship a terminal.
    command = "x-terminal-emulator";
    args = [`--working-directory=${cwd}`];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    // Swallowed intentionally: the child is detached and we have no channel
    // back to the renderer for this fire-and-forget action.
    console.error(`Failed to open terminal at ${cwd}:`, error);
  });
  child.unref();
}

/**
 * Register every IPC handler. Handlers re-validate their arguments: the
 * renderer is not a trust boundary, so nothing it sends is taken on faith.
 */
export function registerIpcHandlers(): void {
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

  /**
   * Native confirmation dialog. Replaces `window.confirm`, which blocks the
   * renderer process while open and can leave keyboard focus broken after it
   * closes — the user clicks into a textarea and nothing they type reaches
   * the input. Running the dialog from the main process keeps the renderer's
   * focus state intact because the IPC call is asynchronous.
   *
   * Returns `true` for the affirmative button (index 1). Dismissing the
   * dialog with Escape or the window close button counts as cancel, which is
   * the safe default for every destructive action this backs.
   */
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
        // Focus the cancel button by default so a stray Enter on a
        // destructive prompt cancels rather than confirms it.
        defaultId: 0,
        cancelId: 0,
        // Windows renders buttons as command links by default; keeping them
        // as plain buttons matches the platform's simpler dialogs and keeps
        // the button row compact.
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

  ipcMain.handle(
    IpcChannel.ScanDirectory,
    async (_event, root: unknown): Promise<ScanResult> => {
      return scanDirectory(requireString(root, "root"));
    },
  );

  /* ---------------------------------------------------------------------- *
   * AI file selection
   * ---------------------------------------------------------------------- */

  ipcMain.handle(
    IpcChannel.AiSettingsGet,
    async (): Promise<{ settings: AiSettings; providers: ReturnType<typeof listProviders> }> => {
      return { settings: await getSettings(), providers: listProviders() };
    },
  );

  ipcMain.handle(
    IpcChannel.AiSettingsSave,
    async (_event, request: unknown): Promise<AiSettings> => {
      const typed = request as AiSettingsSaveRequest;
      // `undefined` means "leave unchanged"; `null` means "clear the
      // selection". `saveSettings` distinguishes the two internally, so
      // passing each field straight through is the correct behaviour.
      //
      // Every field on `AiSettingsSaveRequest` must be forwarded here. This
      // handler builds a fresh object rather than spreading `typed`, so a
      // field that is not listed below is silently dropped before it
      // reaches `saveSettings` — which is exactly what was happening to
      // `suggestMethod`: the renderer sent it, the preload forwarded it,
      // and this object literal discarded it, so the setting never
      // persisted and the radio button snapped back to the old value.
      return saveSettings({
        provider: typed?.provider,
        model: typed?.model,
        apiKey: typed?.apiKey,
        suggestMethod: typed?.suggestMethod,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.AiListModels,
    async (_event, provider: unknown): Promise<string[]> => {
      // Validate the provider id here rather than in the caller so an
      // unknown value never reaches the provider registry.
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
      // A dry run only measures the full-skeleton token count for the
      // "this map is huge" warning. That number is produced by the current
      // method's map builder, regardless of which pipeline the user picked.
      if (normalised.dryRun) {
        return suggestFiles(normalised, settings.provider ?? "deepseek");
      }
      const method = settings.suggestMethod ?? "current";
      // The no-LLM variant never calls a provider, so it does not require
      // an API key. Falling through to the provider check below would
      // refuse the request for a user who has not configured one — which
      // is exactly the user most likely to want an offline method.
      if (method === "gitnexus-only") {
        return suggestFilesGitNexusOnly(
          normalised,
          settings.provider ?? "deepseek",
        );
      }
      if (!settings.provider) {
        throw new Error(
          "No AI provider selected. Choose one in the Settings tab.",
        );
      }
      if (method === "gitnexus") {
        return suggestFilesGitNexus(normalised, settings.provider);
      }
      return suggestFiles(normalised, settings.provider);
    },
  );

  ipcMain.handle(
    IpcChannel.BuildPrompt,
    async (_event, request: unknown): Promise<PromptBuildResult> => {
      const typed = request as PromptBuildRequest;
      if (!Array.isArray(typed?.files))
        throw new Error("Invalid files: expected an array.");
      const root =
        typeof typed?.projectRoot === "string" ? typed.projectRoot : "";
      // An empty root is only legitimate when there is nothing to read from
      // it. `buildPrompt` never touches the filesystem with an empty file
      // list, so this lets the renderer produce the base prompt (the output
      // contract alone) with no project open, while still refusing a
      // selection that pretends to read from a missing root.
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

  ipcMain.handle(
    IpcChannel.OpenTerminal,
    async (_event, root: unknown): Promise<void> => {
      openTerminalAt(requireString(root, "root"));
    },
  );

  /* ---------------------------------------------------------------------- *
   * Git source control
   * ---------------------------------------------------------------------- */

  ipcMain.handle(
    IpcChannel.GitStatus,
    async (_event, root: unknown): Promise<GitStatus | null> => {
      return getStatus(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitInit,
    async (_event, request: unknown): Promise<GitInitResult> => {
      const typed = request as GitInitRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      return initRepository(root);
    },
  );

  ipcMain.handle(
    IpcChannel.GitStage,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitStageRequest;
      await stageFile(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitStageAll,
    async (_event, root: unknown): Promise<void> => {
      await stageAllFiles(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitUnstage,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitUnstageRequest;
      await unstageFile(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiscard,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitDiscardRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      const relativePath = requireString(typed?.path, "path");
      if (typed?.untracked === true) {
        // An untracked file has no index entry to restore from, so discard
        // means removal from disk. There is no version to preserve — the
        // file was never committed.
        await deleteFile(root, relativePath);
      } else {
        await discardFile(root, relativePath);
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiscardAll,
    async (_event, root: unknown): Promise<void> => {
      await discardAllFiles(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitCommit,
    async (_event, request: unknown): Promise<GitCommitResult> => {
      const typed = request as GitCommitRequest;
      return commitChanges(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.message, "message"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiff,
    async (_event, request: unknown): Promise<GitDiffContent> => {
      const typed = request as GitDiffRequest;
      return getDiffContent(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
        typed?.staged === true,
      );
    },
  );
}
