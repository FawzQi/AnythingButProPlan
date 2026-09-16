import { spawn } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { countTokens } from 'gpt-tokenizer'
import { IpcChannel } from '@shared/ipc-channels'
import type {
  ApplyRequest,
  ApplyResult,
  DiffRequest,
  DiffResult,
  ParseResult,
  PromptBuildRequest,
  PromptBuildResult,
  ScanResult,
  WriteFileRequest,
  WriteFileResult,
} from '@shared/types'
import {
  scanDirectory,
  readTextFile,
  writeFileEnsuringDir,
  writeFileWithBackup,
} from './services/fs-service'
import { buildPrompt } from './services/prompt-builder'
import { applyFiles, computeDiff } from './services/apply-engine'
import { parseResponse } from './services/response-parser'

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Invalid ${label}: expected a non-empty string.`)
  }
  return value
}

/**
 * Launch the platform's terminal emulator in `cwd`. Detached + unref so the
 * child outlives this process — a terminal the user opened should stay open
 * after the app quits.
 */
function openTerminalAt(cwd: string): void {
  const platform = process.platform

  let command: string
  let args: string[]

  if (platform === 'win32') {
    // `start` needs an explicit title argument, else a quoted first argument
    // is interpreted as the window title instead of the program.
    command = 'cmd'
    args = ['/c', 'start', '', 'cmd', '/K', `cd /d "${cwd}"`]
  } else if (platform === 'darwin') {
    command = 'open'
    args = ['-a', 'Terminal', cwd]
  } else {
    // Linux/BSD: x-terminal-emulator is the Debian alternatives entry point
    // and is present on most desktops that ship a terminal.
    command = 'x-terminal-emulator'
    args = [`--working-directory=${cwd}`]
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', (error) => {
    // Swallowed intentionally: the child is detached and we have no channel
    // back to the renderer for this fire-and-forget action.
    console.error(`Failed to open terminal at ${cwd}:`, error)
  })
  child.unref()
}

/**
 * Register every IPC handler. Handlers re-validate their arguments: the
 * renderer is not a trust boundary, so nothing it sends is taken on faith.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.PickDirectory, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IpcChannel.ScanDirectory, async (_event, root: unknown): Promise<ScanResult> => {
    return scanDirectory(requireString(root, 'root'))
  })

  ipcMain.handle(
    IpcChannel.BuildPrompt,
    async (_event, request: unknown): Promise<PromptBuildResult> => {
      const typed = request as PromptBuildRequest
      const root = requireString(typed?.projectRoot, 'projectRoot')
      if (!Array.isArray(typed?.files)) throw new Error('Invalid files: expected an array.')
      return buildPrompt(root, typed.files.map((file) => requireString(file, 'file path')))
    },
  )

  ipcMain.handle(IpcChannel.CountTokens, async (_event, text: unknown): Promise<number> => {
    return countTokens(typeof text === 'string' ? text : '')
  })

  ipcMain.handle(
    IpcChannel.ReadFile,
    async (_event, root: unknown, relativePath: unknown): Promise<string> => {
      return readTextFile(requireString(root, 'root'), requireString(relativePath, 'path'))
    },
  )

  ipcMain.handle(IpcChannel.WriteFile, async (_event, request: unknown): Promise<WriteFileResult> => {
    const typed = request as WriteFileRequest
    const root = requireString(typed?.projectRoot, 'projectRoot')
    const relativePath = requireString(typed?.path, 'path')
    const content = typeof typed?.content === 'string' ? typed.content : ''
    return writeFileWithBackup(root, relativePath, content)
  })

  ipcMain.handle(IpcChannel.DiffFile, async (_event, request: unknown): Promise<DiffResult> => {
    const typed = request as DiffRequest
    return computeDiff(
      requireString(typed?.projectRoot, 'projectRoot'),
      requireString(typed?.path, 'path'),
      typeof typed?.content === 'string' ? typed.content : '',
    )
  })

  ipcMain.handle(IpcChannel.ApplyFiles, async (_event, request: unknown): Promise<ApplyResult[]> => {
    const typed = request as ApplyRequest
    const root = requireString(typed?.projectRoot, 'projectRoot')
    if (!Array.isArray(typed?.files)) throw new Error('Invalid files: expected an array.')
    return applyFiles({
      projectRoot: root,
      files: typed.files.map((file) => ({
        path: requireString(file?.path, 'path'),
        content: typeof file?.content === 'string' ? file.content : '',
      })),
    })
  })

  ipcMain.handle(
    IpcChannel.SavePrompt,
    async (event, content: unknown, suggestedName: unknown): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        defaultPath: typeof suggestedName === 'string' ? suggestedName : 'prompt.md',
        filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await writeFileEnsuringDir(result.filePath, requireString(content, 'content'))
      return result.filePath
    },
  )

  ipcMain.handle(IpcChannel.CopyText, async (_event, text: unknown): Promise<void> => {
    clipboard.writeText(requireString(text, 'text'))
  })

  ipcMain.handle(IpcChannel.ParseResponse, async (_event, raw: unknown): Promise<ParseResult> => {
    return parseResponse(typeof raw === 'string' ? raw : '')
  })

  ipcMain.handle(IpcChannel.OpenTerminal, async (_event, root: unknown): Promise<void> => {
    openTerminalAt(requireString(root, 'root'))
  })
}
