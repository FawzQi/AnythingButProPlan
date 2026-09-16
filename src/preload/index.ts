import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  ApplyRequest,
  ApplyResult,
  CleanBackupsResult,
  DiffRequest,
  DiffResult,
  ParseResult,
  PromptBuildRequest,
  PromptBuildResult,
  ScanResult,
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
  diffFile: (request: DiffRequest): Promise<DiffResult> =>
    ipcRenderer.invoke(IpcChannel.DiffFile, request),
  applyFiles: (request: ApplyRequest): Promise<ApplyResult[]> =>
    ipcRenderer.invoke(IpcChannel.ApplyFiles, request),
  savePrompt: (
    content: string,
    suggestedName: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.SavePrompt, content, suggestedName),
  cleanBackups: (root: string): Promise<CleanBackupsResult> =>
    ipcRenderer.invoke(IpcChannel.CleanBackups, root),
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.CopyText, text),
  openTerminal: (root: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.OpenTerminal, root),
};

export type LARPGentApi = typeof api;

contextBridge.exposeInMainWorld("LARPGent", api);
