/**
 * Every IPC channel name lives here. Never use a bare string literal at a
 * call site — main and preload both import this enum so a rename breaks the
 * build instead of silently breaking at runtime.
 */
export const IpcChannel = {
  PickDirectory: 'dialog:pick-directory',
  ScanDirectory: 'fs:scan-directory',
  BuildPrompt: 'prompt:build',
  ParseResponse: 'prompt:parse-response',
  CountTokens: 'prompt:count-tokens',
  ReadFile: 'fs:read-file',
  WriteFile: 'fs:write-file',
  DeleteFile: 'fs:delete-file',
  DiffFile: 'fs:diff-file',
  ApplyFiles: 'fs:apply-files',
  SavePrompt: 'fs:save-prompt',
  CleanBackups: 'fs:clean-backups',
  CopyText: 'clipboard:write',
  OpenTerminal: 'shell:open-terminal',
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
