import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  AiProviderId,
  AiProviderInfo,
  AiSettings,
  AiSettingsSaveRequest,
  AiSuggestion,
  AiSuggestRequest,
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
  WebChatTargetInfo,
  WriteFileRequest,
  WriteFileResult,
} from "@shared/types";

/**
 * The entire surface the renderer gets. Each entry is a thin wrapper over one
 * IPC channel — the renderer never sees `ipcRenderer` itself and never touches
 * the filesystem.
 */
const api = {
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.PickDirectory),
  confirmDialog: (request: ConfirmDialogRequest): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.ConfirmDialog, request),
  scanDirectory: (root: string): Promise<ScanResult> =>
    ipcRenderer.invoke(IpcChannel.ScanDirectory, root),
  buildPrompt: (request: PromptBuildRequest): Promise<PromptBuildResult> =>
    ipcRenderer.invoke(IpcChannel.BuildPrompt, request),
  countTokens: (text: string): Promise<number> =>
    ipcRenderer.invoke(IpcChannel.CountTokens, text),
  parseResponse: (raw: string): Promise<ParseResult> =>
    ipcRenderer.invoke(IpcChannel.ParseResponse, raw),
  readFile: (root: string, relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannel.ReadFile, root, relativePath),
  writeFile: (request: WriteFileRequest): Promise<WriteFileResult> =>
    ipcRenderer.invoke(IpcChannel.WriteFile, request),
  deleteFile: (request: DeleteFileRequest): Promise<DeleteFileResult> =>
    ipcRenderer.invoke(IpcChannel.DeleteFile, request),
  diffFile: (request: DiffRequest): Promise<DiffResult> =>
    ipcRenderer.invoke(IpcChannel.DiffFile, request),
  gitStatus: (root: string): Promise<GitStatus | null> =>
    ipcRenderer.invoke(IpcChannel.GitStatus, root),
  gitInit: (request: GitInitRequest): Promise<GitInitResult> =>
    ipcRenderer.invoke(IpcChannel.GitInit, request),
  gitStage: (request: GitStageRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.GitStage, request),
  gitStageAll: (root: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.GitStageAll, root),
  gitUnstage: (request: GitUnstageRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.GitUnstage, request),
  gitDiscard: (request: GitDiscardRequest): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.GitDiscard, request),
  gitDiscardAll: (root: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.GitDiscardAll, root),
  gitCommit: (request: GitCommitRequest): Promise<GitCommitResult> =>
    ipcRenderer.invoke(IpcChannel.GitCommit, request),
  gitDiff: (request: GitDiffRequest): Promise<GitDiffContent> =>
    ipcRenderer.invoke(IpcChannel.GitDiff, request),
  applyFiles: (request: ApplyRequest): Promise<ApplyResult[]> =>
    ipcRenderer.invoke(IpcChannel.ApplyFiles, request),
  savePrompt: (
    content: string,
    suggestedName: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.SavePrompt, content, suggestedName),
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.CopyText, text),
  openTerminal: (root: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.OpenTerminal, root),
  aiGetSettings: (): Promise<{
    settings: AiSettings;
    providers: AiProviderInfo[];
    webChatTargets: WebChatTargetInfo[];
  }> => ipcRenderer.invoke(IpcChannel.AiSettingsGet),
  aiSaveSettings: (request: AiSettingsSaveRequest): Promise<AiSettings> =>
    ipcRenderer.invoke(IpcChannel.AiSettingsSave, request),
  aiListModels: (provider: AiProviderId): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannel.AiListModels, provider),
  aiSuggestFiles: (request: AiSuggestRequest): Promise<AiSuggestion> =>
    ipcRenderer.invoke(IpcChannel.AiSuggestFiles, request),
  webChatSend: (request: WebChatSendRequest): Promise<WebChatSendResult> =>
    ipcRenderer.invoke(IpcChannel.WebChatSend, request),
  webChatOpen: (target: WebChatTargetId): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.WebChatOpen, target),
  webChatCancel: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.WebChatCancel),
};

export type AnythingButProPlanApi = typeof api;

contextBridge.exposeInMainWorld("AnythingButProPlan", api);
