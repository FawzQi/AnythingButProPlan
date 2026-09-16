/**
 * Types shared between main and renderer. Everything crossing the contextBridge
 * boundary must be structured-cloneable: no functions, no class instances.
 */

export interface FileNode {
  id: string
  name: string
  /** POSIX-style path relative to the project root. */
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  selected: boolean
  expanded: boolean
  /** Byte size for files; undefined for directories. */
  size?: number
}

export interface ScanResult {
  root: string
  tree: FileNode
  /** Number of files that passed the gitignore/binary filters. */
  fileCount: number
  /** Number of entries dropped by .gitignore or the always-skip list. */
  skippedCount: number
}

export type PathSource =
  | 'file-header'
  | 'xml'
  | 'first-line-comment'
  | 'preceding-text'
  | 'language-hint'
  | 'user'

export interface ParsedFile {
  /** null = ambiguous, needs user input. */
  path: string | null
  /** Raw code, unmodified — never normalized or reformatted. */
  content: string
  language: string | null
  pathSource: PathSource
  ambiguous: boolean
  /** Original text for debugging. */
  rawBlock: string
}

export type ParseStrategy = 'xml' | 'markdown' | 'plaintext' | 'user-assisted'

export interface ParseResult {
  files: ParsedFile[]
  strategy: ParseStrategy
  warnings: string[]
}

export interface ApplyRequest {
  projectRoot: string
  files: Array<{ path: string; content: string }>
}

export interface ApplyResult {
  path: string
  status: 'created' | 'overwritten' | 'skipped' | 'failed'
  error?: string
  /** Path of the .bak file, when one was written. */
  backupPath?: string
}

export interface PromptBuildRequest {
  projectRoot: string
  /** POSIX-relative paths of the selected files. */
  files: string[]
}

export interface PromptBuildResult {
  prompt: string
  tokenCount: number
  fileCount: number
  /** Files that were selected but could not be read. */
  unreadable: string[]
}

export interface DiffRequest {
  projectRoot: string
  path: string
  /** Proposed content; the existing content is read from disk. */
  content: string
}

export interface DiffResult {
  original: string
  modified: string
  exists: boolean
}

export interface WriteFileRequest {
  projectRoot: string
  path: string
  content: string
}

export interface WriteFileResult {
  status: 'created' | 'overwritten' | 'skipped'
  backupPath?: string
}

export interface CleanBackupsResult {
  /** Number of .bak files removed from disk. */
  deleted: number
  /** POSIX-relative paths of the removed files, for reporting. */
  paths: string[]
  /** Files that could not be removed, with the reason. */
  errors: Array<{ path: string; error: string }>
}
