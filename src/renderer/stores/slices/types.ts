import type {
  AiProviderId,
  AiProviderInfo,
  AiSettings,
  AiSettingsSaveRequest,
  AiSuggestion,
  ApplyResult,
  DebugCommandResult,
  FileNode,
  GitStatus,
  ParsedFile,
  ParseResult,
  RecentFolder,
} from "@shared/types";
import type { SessionSlice } from "./session-slice";

export function parsedFileKey(file: ParsedFile, index: number): string {
  return file.path ?? `#${index}`;
}

export type EditorTab = "prompt" | "editor" | "source" | "settings";

export interface ProjectSlice {
  projectRoot: string | null;
  tree: FileNode | null;
  fileCount: number;
  scanning: boolean;
  recentFolders: RecentFolder[];
  recentFoldersLoading: boolean;

  loadRecentFolders: () => Promise<void>;
  openProjectByPath: (path: string) => Promise<void>;
  removeRecentFolder: (path: string) => Promise<void>;
  clearRecentFolders: () => Promise<void>;
  openProject: () => Promise<void>;
  refreshProject: () => Promise<void>;
  openTerminal: () => Promise<void>;
  toggleNode: (id: string, selected: boolean) => void;
  toggleExpanded: (id: string) => void;
  selectAll: (selected: boolean) => void;
}

export interface PromptSlice {
  prompt: string;
  tokenCount: number;
  promptFileCount: number;
  unreadable: string[];
  sensitiveFiles: string[];
  building: boolean;
  customPrompt: string;
  mapTokenCount: number | null;
  aiSuggesting: boolean;
  aiLastSuggestion: AiSuggestion | null;

  calculateMapTokens: () => Promise<void>;
  suggestFiles: () => Promise<void>;
  buildPrompt: () => Promise<void>;
  clearPrompt: () => void;
  copyPrompt: () => Promise<void>;
  savePrompt: () => Promise<void>;
  setCustomPrompt: (value: string) => void;
}

export interface ResponseSlice {
  rawResponse: string;
  parseResult: ParseResult | null;
  includes: Record<string, boolean>;
  applyResults: ApplyResult[] | null;
  applying: boolean;
  debugRunning: boolean;
  debugResults: DebugCommandResult[] | null;
  debugLog: string;
  debugActiveCommandIndex: number | null;
  /**
   * Opt-in, per app session: skip the confirmation dialog before running the
   * parsed `===Debug===` commands. Off by default. The toggle lives in the
   * debug panel, next to the command list, so enabling it is a deliberate act
   * taken while looking at the commands.
   */
  debugAutoRun: boolean;

  setResponse: (raw: string) => Promise<void>;
  setParsedPath: (index: number, path: string) => void;
  toggleInclude: (key: string, included: boolean) => void;
  applySelected: () => Promise<void>;
  setDebugAutoRun: (enabled: boolean) => void;
  runDebugCommands: () => Promise<void>;
  killDebugCommands: () => Promise<void>;
  clearDebug: () => void;
}

export interface EditorSlice {
  editorTab: EditorTab;
  editingPath: string | null;
  editingContent: string;
  editingOriginal: string;
  editingLoading: boolean;
  saving: boolean;
  deletingPath: string | null;

  setEditorTab: (tab: EditorTab) => void;
  openFileForEdit: (path: string) => Promise<void>;
  closeEditor: () => void;
  setEditingContent: (content: string) => void;
  saveEditingFile: () => Promise<void>;
  revertEditingFile: () => void;
  deleteFileFromTree: (path: string) => Promise<void>;
}

export interface GitSlice {
  gitStatus: GitStatus | null | undefined;
  gitStatusLoading: boolean;
  gitBusy: boolean;
  gitCommitMessage: string;

  refreshGitStatus: () => Promise<void>;
  initGitRepo: () => Promise<void>;
  stageGitPath: (path: string) => Promise<void>;
  stageAllGitPaths: () => Promise<void>;
  unstageGitPath: (path: string) => Promise<void>;
  discardGitPath: (path: string, untracked: boolean) => Promise<void>;
  discardAllGitPaths: () => Promise<void>;
  commitGitChanges: () => Promise<void>;
  setGitCommitMessage: (message: string) => void;
}

export interface SettingsSlice {
  aiProviders: AiProviderInfo[];
  aiSettings: AiSettings | null;
  aiSettingsLoading: boolean;
  aiModelsByProvider: Partial<Record<AiProviderId, string[]>>;
  aiModelsLoading: boolean;
  notice: string | null;
  error: string | null;

  loadAiSettings: () => Promise<void>;
  saveAiSettings: (request: AiSettingsSaveRequest) => Promise<void>;
  loadAiModels: (provider: AiProviderId) => Promise<void>;
  setNotice: (notice: string | null) => void;
  clearNotice: () => void;
}

export type AppStoreState = ProjectSlice &
  PromptSlice &
  ResponseSlice &
  EditorSlice &
  GitSlice &
  SettingsSlice &
  SessionSlice;
