/**
 * Every IPC channel name lives here. Never use a bare string literal at a
 * call site — main and preload both import this enum so a rename breaks the
 * build instead of silently breaking at runtime.
 */
export const IpcChannel = {
  PickDirectory: 'dialog:pick-directory',
  ConfirmDialog: 'dialog:confirm',
  ScanDirectory: 'fs:scan-directory',
  BuildPrompt: 'prompt:build',
  ParseResponse: 'prompt:parse-response',
  CountTokens: 'prompt:count-tokens',
  ReadFile: 'fs:read-file',
  WriteFile: 'fs:write-file',
  DeleteFile: 'fs:delete-file',
  DiffFile: 'fs:diff-file',
  GitStatus: 'git:status',
  GitInit: 'git:init',
  GitStage: 'git:stage',
  GitStageAll: 'git:stage-all',
  GitUnstage: 'git:unstage',
  GitDiscard: 'git:discard',
  GitDiscardAll: 'git:discard-all',
  GitCommit: 'git:commit',
  GitDiff: 'git:diff',
  ApplyFiles: 'fs:apply-files',
  SavePrompt: 'fs:save-prompt',
  CopyText: 'clipboard:write',
  OpenTerminal: 'shell:open-terminal',
  AiSettingsGet: 'ai:settings-get',
  AiSettingsSave: 'ai:settings-save',
  AiListModels: 'ai:list-models',
  AiSuggestFiles: 'ai:suggest-files',
  WebChatSend: 'webchat:send',
  WebChatOpen: 'webchat:open',
  WebChatCancel: 'webchat:cancel',
  ResearchScan: 'research:scan',
  ResearchConvert: 'research:convert',
  ResearchConvertProgress: 'research:convert-progress',
  ResearchBuildIndex: 'research:index-build',
  ResearchIndexProgress: 'research:index-progress',
  ResearchBuildPrompt: 'research:build-prompt',
  // One cancel channel for both long research jobs. The flag lives per
  // project under one key, so a conversion and an index build started in the
  // same project cannot be cancelled independently — starting the second
  // clears the flag the first would have read. See `cancellation.ts`.
  ResearchCancel: 'research:cancel',
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]