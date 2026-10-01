import { spawn } from "node:child_process";
import { BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { countTokens } from "gpt-tokenizer";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  AiProviderId,
  AiSettings,
  AiSettingsSaveRequest,
  AiSuggestion,
  AiSuggestRequest,
  ApplyFileInput,
  ConversionMode,
  ConvertRequest,
  ExtractionEngine,
  ConvertResult,
  DocumentEntry,
  IndexBuildRequest,
  IndexBuildResult,
  RecentFolder,
  ResearchCancelRequest,
  ResearchPromptRequest,
  ResearchPromptResult,
  ResearchScanResult,
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
  WebChatSendRequest,
  WebChatSendResult,
  WebChatTargetId,
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
import { convertDocuments } from "./services/document-converter";
import {
  ensureGitignore,
  scanDocuments,
} from "./services/document-scanner";
import { buildIndex } from "./services/research-index";
import { buildResearchPrompt } from "./services/research-prompt";
import { clearCancel, requestCancel } from "./services/cancellation";
import { DEFAULT_VISION_PROVIDER, VISION_PROVIDERS } from "@shared/vision-providers";
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
import { measureMapTokens } from "./services/file-selector";
import {
  suggestFilesGitNexusOnly,
  suggestFilesGitNexusJev,
  suggestFilesGitNexusLlm,
} from "./services/gitnexus-selector";
import {
  addRecentFolder,
  clearRecentFolders,
  listRecentFolders,
  removeRecentFolder,
} from "./services/recent-folders";
import {
  discoverModels,
  listProviders,
} from "./services/ai-providers";
import {
  cancelWebChat,
  listWebChatTargets,
  openWebChat,
  sendToWebChat,
} from "./services/web-chat";

/**
 * Vision provider ids arrive from the renderer's picker, so they are checked
 * against the shared catalogue rather than trusted. An unknown value falls
 * back to the default instead of throwing: the picker is the only caller, and
 * a stale renderer bundle carrying a provider this build removed should not
 * fail a conversion the user asked for.
 */
function requireVisionProvider(
  value: unknown,
): DocumentEntry["visionProvider"] {
  const ids = VISION_PROVIDERS.map((option) => option.id);
  return ids.includes(value as AiProviderId)
    ? (value as AiProviderId)
    : DEFAULT_VISION_PROVIDER;
}

/**
 * A string field that is allowed to be empty.
 *
 * `requireString` answers "is this a usable value?", which is the wrong
 * question for an optional field: a whole-document build has no question, and
 * the renderer sends `question: ""` for it rather than omitting the key.
 * Rejecting that turned a valid full-document build into
 * `Invalid question: expected a non-empty string.` The requirement that a RAG
 * build *has* a question is a rule about the mode, not about the field's
 * type — it belongs where the mode is known, and it is checked in
 * `buildResearchPrompt`.
 */
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected a string.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
  return value;
}

const WEB_CHAT_TARGET_IDS: readonly WebChatTargetId[] = [
  "deepseek",
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "qwen",
];

function requireWebChatTarget(value: unknown): WebChatTargetId {
  if (
    typeof value !== "string" ||
    !(WEB_CHAT_TARGET_IDS as readonly string[]).includes(value)
  ) {
    throw new Error(`Unknown web chat target: ${String(value)}`);
  }
  return value as WebChatTargetId;
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
   * Recent folders
   * ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- *
   * AI file selection
   * ---------------------------------------------------------------------- */

  ipcMain.handle(
    IpcChannel.AiSettingsGet,
    async (): Promise<{
      settings: AiSettings;
      providers: ReturnType<typeof listProviders>;
      webChatTargets: ReturnType<typeof listWebChatTargets>;
    }> => {
      return {
        settings: await getSettings(),
        providers: listProviders(),
        webChatTargets: listWebChatTargets(),
      };
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
        webChatTarget: typed?.webChatTarget,
        mode: typed?.mode,
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
      // A dry run only measures the full-skeleton token count, which the
      // Prompt tab shows in its footer as "map tokens". Nothing is
      // selected and no provider is contacted.
      if (normalised.dryRun) {
        return measureMapTokens(normalised);
      }
      const method = settings.suggestMethod ?? "gitnexus-only";
      if (method === "gitnexus-only") {
        // Purely local. The provider string on the result is only a
        // display field and does not imply an API call was made.
        return suggestFilesGitNexusOnly(
          normalised,
          settings.provider ?? "deepseek",
        );
      }
      if (method === "gitnexus-jev") {
        // Talks to TypeSafe, not to a chat provider. The selector reads
        // the TypeSafe key itself and raises a targeted error if missing.
        return suggestFilesGitNexusJev(normalised);
      }
      if (method === "gitnexus-llm") {
        // Talks to whichever chat provider the user selected in Settings.
        // The provider id on the result is the one that was actually
        // called, not a display placeholder — this path makes a real
        // outbound request.
        return suggestFilesGitNexusLlm(
          normalised,
          settings.provider ?? "deepseek",
        );
      }
      // Unreachable given the `SuggestMethod` union, but keeping the
      // exhaustive check here means a future addition to the union fails
      // loudly rather than silently falling through to a default.
      throw new Error(`Unknown suggestion method: ${String(method)}`);
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
   * Web chat bridge
   * ---------------------------------------------------------------------- */

  ipcMain.handle(
    IpcChannel.WebChatSend,
    async (_event, request: unknown): Promise<WebChatSendResult> => {
      const typed = request as WebChatSendRequest;
      const target = requireWebChatTarget(typed?.target);
      const prompt = requireString(typed?.prompt, "prompt");
      return sendToWebChat(target, prompt);
    },
  );

  ipcMain.handle(
    IpcChannel.WebChatOpen,
    async (_event, target: unknown): Promise<void> => {
      await openWebChat(requireWebChatTarget(target));
    },
  );

  ipcMain.handle(IpcChannel.WebChatCancel, async (): Promise<void> => {
    cancelWebChat();
  });

  /* ---------------------------------------------------------------------- *
   * Research mode
   * ---------------------------------------------------------------------- */

  ipcMain.handle(
    IpcChannel.ResearchScan,
    async (_event, root: unknown): Promise<ResearchScanResult> => {
      const projectRoot = requireString(root, "projectRoot");
      // Phase 9 housekeeping runs here rather than at conversion time: this
      // is the first call that proves the folder is a research project (it
      // has a docs/ directory), and doing it on open means `converted/` is
      // ignored before anything writes into it.
      const scan = await scanDocuments(projectRoot);
      if (scan.docsDirExists || scan.sourceDir === "root") {
        try {
          await ensureGitignore(projectRoot);
        } catch (error) {
          // A read-only project is not a reason to fail the scan.
          console.warn("Could not update .gitignore:", String(error));
        }
      }
      return scan;
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchConvert,
    async (event, request: unknown): Promise<ConvertResult> => {
      const typed = request as ConvertRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const mode: ConversionMode =
        typed?.mode === "text-images" ? "text-images" : "text";
      // `auto` (the default) is Docling, run inside its own virtualenv.
      // `fast` stays as the offline text extractor and `webchat` as the
      // browser-driven one.
      const engine: ExtractionEngine =
        typed?.engine === "fast"
          ? "fast"
          : typed?.engine === "webchat"
            ? "webchat"
            : "auto";
      const visionProvider = requireVisionProvider(typed?.visionProvider);

      // Read once, before the long job starts: `webchat` needs the chat site
      // the user selected, and re-reading the settings file mid-conversion
      // would let a settings change halfway through send the second document
      // to a different destination than the first. Docling reads its venv
      // path from the environment (DOCLING_VENV) rather than from Settings.
      const settings = await getSettings();

      // The flag is cleared before the job starts so a cancel left over from
      // a previous run — the user pressed Cancel and the job had already
      // finished — does not abort this one at document 1.
      clearCancel(projectRoot);
      const sender = event.sender;
      return convertDocuments({
        projectRoot,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        mode,
        engine,
        // The chat site comes from Settings (`webChatTarget`), the same one
        // the "Send to web chat" button uses. Passing it in rather than
        // reading it inside the converter keeps the converter free of the
        // settings module and makes the engine's dependency explicit.
        webChatTarget: settings.webChatTarget,
        visionProviderId: visionProvider,
        onProgress: (progress) => {
          // The renderer may have closed the window while a conversion was
          // running; a send to a destroyed webContents throws.
          if (!sender.isDestroyed()) {
            sender.send(IpcChannel.ResearchConvertProgress, progress);
          }
        },
      });
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchBuildIndex,
    async (event, request: unknown): Promise<IndexBuildResult> => {
      const typed = request as IndexBuildRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      clearCancel(projectRoot);
      const sender = event.sender;
      const result = await buildIndex({
        projectRoot,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        onProgress: (progress) => {
          if (!sender.isDestroyed()) {
            sender.send(IpcChannel.ResearchIndexProgress, progress);
          }
        },
      });
      return { index: result.index, skipped: result.skipped };
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchBuildPrompt,
    async (_event, request: unknown): Promise<ResearchPromptResult> => {
      const typed = request as ResearchPromptRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const mode = typed?.mode === "rag" ? "rag" : "full";
      const topK = typed?.topK;
      if (
        topK !== undefined &&
        (!Number.isInteger(topK) || topK < 1 || topK > 50)
      ) {
        throw new Error(`topK must be an integer between 1 and 50.`);
      }
      return buildResearchPrompt({
        projectRoot,
        mode,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        question: optionalString(typed?.question, "question"),
        topK,
        rerank: typed?.rerank === true,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchCancel,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as ResearchCancelRequest;
      requestCancel(requireString(typed?.projectRoot, "projectRoot"));
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