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
  /**
   * True when the file's name matches a pattern for files that routinely
   * carry secrets (`.env`, `id_rsa`, `*.pem`, `credentials.json`, …). The
   * tree renders these with a warning indicator and the prompt build reports
   * them, so the user always knows what is about to be pasted into a chat.
   */
  sensitive?: boolean
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
  | 'first-line-comment'
  | 'preceding-text'
  | 'language-hint'
  | 'delete-header'
  | 'user'

/**
 * One SEARCH/REPLACE pair. The SEARCH text is matched against the file on
 * disk as an exact substring first, then — if that fails — as a
 * whitespace-tolerant line match. A pair that matches neither way is
 * rejected; the applier never guesses.
 */
export interface PatchBlock {
  search: string
  replace: string
}

export interface ParsedFile {
  /** null = ambiguous, needs user input. */
  path: string | null
  /**
   * Full content for a new/rewritten file; the rendered patch text (for
   * display) when `patches` is set.
   */
  content: string
  language: string | null
  pathSource: PathSource
  ambiguous: boolean
  /** Original text for debugging. */
  rawBlock: string
  /**
   * SEARCH/REPLACE pairs the AI emitted for an existing file. When present
   * and non-empty, the applier reads the file from disk, applies each pair in
   * order, and writes the result — `content` is ignored.
   */
  patches?: PatchBlock[]
  /**
   * When true, this entry is a delete directive (`Delete: <path>` in the
   * response): the applier renames the file to a `.bak` sibling rather than
   * writing `content` or applying `patches`.
   */
  delete?: boolean
}

export type ParseStrategy =
  | 'markdown'
  | 'patch'
  | 'plaintext'
  | 'delete'
  | 'user-assisted'

export interface ParseResult {
  files: ParsedFile[]
  strategy: ParseStrategy
  warnings: string[]
}

export interface ApplyFileInput {
  path: string
  /** Ignored when `patches` is present and non-empty, and when `delete` is set. */
  content: string
  patches?: PatchBlock[]
  /**
   * When true, the applier deletes `path` (renaming it to a `.bak` sibling so
   * the change is reversible) instead of writing any content.
   */
  delete?: boolean
}

export interface ApplyRequest {
  projectRoot: string
  files: ApplyFileInput[]
}

export interface ApplyResult {
  path: string
  status:
    | 'created'
    | 'overwritten'
    | 'patched'
    | 'deleted'
    | 'skipped'
    | 'failed'
  error?: string
}

export interface DeleteFileRequest {
  projectRoot: string
  path: string
}

export interface DeleteFileResult {
  /** `not-found` when the file did not exist on disk. */
  status: 'deleted' | 'not-found'
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
  /**
   * Selected files whose names match a sensitive-file pattern. They are
   * included in `prompt` like any other file — the point is to surface them,
   * not to silently drop them — but the UI warns about them so the user can
   * deselect before copying.
   */
  sensitiveFiles: string[]
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
}

/* ------------------------------------------------------------------------ *
 * Git source control
 * ------------------------------------------------------------------------ */

export type GitFileStatusCode =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'conflicted'

export interface GitFileChange {
  /** POSIX-relative path of the current name. */
  path: string
  status: GitFileStatusCode
  /** Previous path for renames and copies; undefined otherwise. */
  oldPath?: string
}

/**
 * Snapshot of `git status` at a moment in time. `null` from the status call
 * means the folder is not a Git repository — the UI shows an Initialize
 * button in that case rather than an empty panel.
 */
export interface GitStatus {
  /** Current branch name, or `null` when HEAD is detached or unborn. */
  branch: string | null
  /** Number of commits ahead of upstream. */
  ahead: number
  /** Number of commits behind upstream. */
  behind: number
  /** Files with staged changes (index differs from HEAD). */
  staged: GitFileChange[]
  /** Files with unstaged changes (working tree differs from index). */
  unstaged: GitFileChange[]
  /** Untracked files (present in working tree, not in index). */
  untracked: string[]
  /** Files with merge conflicts. */
  conflicted: GitFileChange[]
}

export interface GitInitRequest {
  projectRoot: string
}

export interface GitInitResult {
  /** True when `.git` was created by this call; false when it already existed. */
  created: boolean
}

export interface GitStageRequest {
  projectRoot: string
  path: string
}

export interface GitUnstageRequest {
  projectRoot: string
  path: string
}

export interface GitDiscardRequest {
  projectRoot: string
  path: string
  /**
   * When true the file is untracked and the caller wants it removed from
   * disk entirely rather than restored from Git.
   */
  untracked: boolean
}

export interface GitCommitRequest {
  projectRoot: string
  message: string
}

export interface GitCommitResult {
  /** Full 40-character hash of the new commit. Empty when it could not be read. */
  commitHash: string
  /** Raw stdout from `git commit`, useful for the notice banner. */
  summary: string
}

export interface GitDiffRequest {
  projectRoot: string
  path: string
  /**
   * `true` for a staged diff (index vs HEAD), `false` for an unstaged diff
   * (working tree vs index). For untracked files, only the `false` form is
   * meaningful, and `original` is empty.
   */
  staged: boolean
}

export interface GitDiffContent {
  /** Content of the left side of the diff. */
  original: string
  /** Content of the right side of the diff. */
  modified: string
  /**
   * Whether either side had content. Used to suppress rendering an empty
   * diff for a file that exists in neither ref.
   */
  exists: boolean
}