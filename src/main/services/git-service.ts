import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  GitCommitResult,
  GitDiffContent,
  GitFileChange,
  GitFileStatusCode,
  GitStatus,
} from '@shared/types'
import type { ProcessResult } from './gitnexus'

/**
 * Run `git <args>` with `cwd` set to the project root. `stdio: ignore` for
 * stdin so a Git command that would prompt for credentials or an editor
 * fails fast rather than hanging the main process.
 */
function runGit(root: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Force non-interactive mode so a `git commit` with an editor
      // configured does not block on a terminal we do not have.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) =>
      resolve({ ok: false, stdout, stderr: error.message }),
    )
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

/** True when the folder contains a `.git` directory or file. */
export async function isRepository(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, '.git'))
    return true
  } catch {
    return false
  }
}

export interface InitResult {
  created: boolean
}

/**
 * Initialize a repository in `root`. Idempotent: when `.git` already exists
 * the call is a no-op and reports `created: false`, so the UI can say
 * "already a repository" without treating it as an error.
 */
export async function initRepository(root: string): Promise<InitResult> {
  if (await isRepository(root)) return { created: false }
  const result = await runGit(root, ['init'])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'git init failed.')
  }
  return { created: true }
}

function mapStatusCode(code: string): GitFileStatusCode {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/**
 * Parse the branch header line of `git status --porcelain=v1 --branch`.
 *
 * Possible shapes:
 *   `## main`
 *   `## main...origin/main`
 *   `## main...origin/main [ahead 2, behind 1]`
 *   `## No commits yet on main`
 *   `## Initial commit on main`
 *   `## HEAD (no branch)`
 */
function parseBranchLine(rest: string, status: GitStatus): void {
  const bracket = rest.indexOf(' [')
  const head = bracket === -1 ? rest : rest.slice(0, bracket)
  const bracketPart = bracket === -1 ? '' : rest.slice(bracket + 2, -1)

  if (head.startsWith('No commits yet on ')) {
    status.branch = head.slice('No commits yet on '.length)
    return
  }
  if (head.startsWith('Initial commit on ')) {
    status.branch = head.slice('Initial commit on '.length)
    return
  }
  if (head === 'HEAD (no branch)') {
    status.branch = null
    return
  }

  status.branch = head.split('...')[0] ?? null

  const ahead = /ahead (\d+)/.exec(bracketPart)
  const behind = /behind (\d+)/.exec(bracketPart)
  if (ahead?.[1]) status.ahead = Number(ahead[1])
  if (behind?.[1]) status.behind = Number(behind[1])
}

/**
 * Read the working-tree status. Returns `null` when the folder is not a
 * repository so the UI can present an Initialize button rather than an
 * empty panel.
 *
 * `-z` is not cosmetic. Without it, `--porcelain=v1` C-quotes any pathname
 * that contains whitespace, quotes, backslashes, or non-ASCII bytes —
 * `test copy 2.txt` comes back as the literal string `"test copy 2.txt"`,
 * quotes included. Every downstream command (`git add`, `git restore`,
 * `git show`, the FS `unlink` used for untracked-discard) then targets a
 * path that does not exist and fails:
 *
 *   fatal: pathspec '"test copy 3.txt"' did not match any files
 *   Path is not portable across platforms: "test copy 2.txt"
 *
 * `-z` terminates entries with NUL instead of LF and — critically — disables
 * the C-quoting entirely, so every path arriving here is the real on-disk
 * path. Renames/copies emit the original path as the *next* NUL-separated
 * field rather than as `old -> new` in the same field.
 */
export async function getStatus(root: string): Promise<GitStatus | null> {
  if (!(await isRepository(root))) return null

  const result = await runGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--branch',
  ])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'git status failed.')
  }

  const status: GitStatus = {
    branch: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  }

  const fields = result.stdout.split('\0')
  let index = 0
  while (index < fields.length) {
    const entry = fields[index]
    index += 1
    if (entry === undefined || entry === '') continue

    if (entry.startsWith('## ')) {
      parseBranchLine(entry.slice(3), status)
      continue
    }

    if (entry.length < 4) continue
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    const filePath = entry.slice(3)

    // In `-z` output the original path of a rename/copy is the next field.
    // Peek at the status codes rather than scanning for ` -> `, which a
    // legitimate path could itself contain.
    let oldPath: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = fields[index]
      index += 1
    }

    if (x === '?' && y === '?') {
      status.untracked.push(filePath)
      continue
    }

    // Unmerged statuses (DD, AU, UD, UA, DU, AA, UU) all include a U
    // somewhere, except DD which is a delete/delete conflict.
    if (
      x === 'U' ||
      y === 'U' ||
      (x === 'D' && y === 'D') ||
      (x === 'A' && y === 'A')
    ) {
      status.conflicted.push({ path: filePath, status: 'conflicted', oldPath })
      continue
    }

    if (x !== ' ' && x !== '?') {
      status.staged.push({ path: filePath, status: mapStatusCode(x), oldPath })
    }
    if (y !== ' ' && y !== '?') {
      status.unstaged.push({ path: filePath, status: mapStatusCode(y), oldPath })
    }
  }

  return status
}

export async function stageFile(root: string, relativePath: string): Promise<void> {
  const result = await runGit(root, ['add', '--', relativePath])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'git add failed.')
  }
}

/**
 * Stage every change in the working tree — modified, added, deleted, and
 * untracked. The panel-level "Stage all" action. Uses `-A` rather than `.`
 * so a deletion is staged as a deletion; `git add .` would leave the
 * deletion half-done and require a second command.
 */
export async function stageAllFiles(root: string): Promise<void> {
  const result = await runGit(root, ['add', '-A'])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'git add -A failed.')
  }
}

export async function unstageFile(root: string, relativePath: string): Promise<void> {
  // `git restore --staged` is the modern form. Fall back to the legacy
  // `git reset HEAD --` on Git versions that predate `restore` (pre-2.23),
  // which is still common on older CI images and distros.
  const modern = await runGit(root, ['restore', '--staged', '--', relativePath])
  if (modern.ok) return
  const legacy = await runGit(root, ['reset', 'HEAD', '--', relativePath])
  if (!legacy.ok) {
    throw new Error(legacy.stderr.trim() || 'git unstage failed.')
  }
}

/**
 * Restore the working-tree version of a tracked file from the index. Used
 * by the "Discard changes" action for files with unstaged modifications.
 *
 * Untracked files are handled by the caller: there is no index entry to
 * restore from, so the file must simply be removed from disk.
 */
export async function discardFile(root: string, relativePath: string): Promise<void> {
  const modern = await runGit(root, ['restore', '--worktree', '--', relativePath])
  if (modern.ok) return
  const legacy = await runGit(root, ['checkout', '--', relativePath])
  if (!legacy.ok) {
    throw new Error(legacy.stderr.trim() || 'git discard failed.')
  }
}

/**
 * Discard every unstaged change to a tracked file, restoring the working
 * tree to the index version. Untracked files are deliberately left alone —
 * they have no index entry to restore from, and silently deleting them
 * would be a far larger and more surprising operation than "undo my edits".
 * Staged changes are also left alone; the caller decides whether to unstage
 * them separately.
 */
export async function discardAllFiles(root: string): Promise<void> {
  const modern = await runGit(root, ['restore', '--worktree', '.'])
  if (modern.ok) return
  const legacy = await runGit(root, ['checkout', '--', '.'])
  if (!legacy.ok) {
    throw new Error(legacy.stderr.trim() || 'git discard all failed.')
  }
}

/**
 * Commit everything currently in the index. The caller is responsible for
 * ensuring something is staged — the panel disables the button when there
 * are no staged changes, and `git commit` would fail anyway with a
 * non-zero exit code we surface as an error.
 */
export async function commitChanges(
  root: string,
  message: string,
): Promise<GitCommitResult> {
  const trimmed = message.trim()
  if (trimmed === '') {
    throw new Error('Commit message is required.')
  }
  const result = await runGit(root, ['commit', '-m', trimmed])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'git commit failed.')
  }

  // Resolve the new HEAD separately so the result is always the full hash,
  // even on Git versions whose commit output does not include it cleanly.
  const hashResult = await runGit(root, ['rev-parse', 'HEAD'])
  return {
    commitHash: hashResult.ok ? hashResult.stdout.trim() : '',
    summary: result.stdout.trim(),
  }
}

/**
 * Content of the two sides of a diff for a single file.
 *
 * Unstaged diff (`staged: false`):
 *   original = index content  (`git show :path`)
 *   modified = working tree content (read from disk)
 *
 * Staged diff (`staged: true`):
 *   original = HEAD content   (`git show HEAD:path`)
 *   modified = index content  (`git show :path`)
 *
 * A missing ref resolves to empty content rather than throwing — that is
 * the correct semantics for a file that is being added or deleted, and the
 * diff viewer renders an empty side as a clean add or remove.
 */
export async function getDiffContent(
  root: string,
  relativePath: string,
  staged: boolean,
): Promise<GitDiffContent> {
  const originalRef = staged ? `HEAD:${relativePath}` : `:${relativePath}`
  const originalResult = await runGit(root, ['show', originalRef])
  const original = originalResult.ok ? originalResult.stdout : ''

  let modified: string
  if (staged) {
    const indexResult = await runGit(root, ['show', `:${relativePath}`])
    modified = indexResult.ok ? indexResult.stdout : ''
  } else {
    try {
      modified = await fs.readFile(path.join(root, relativePath), 'utf8')
    } catch {
      // Deleted files have no working-tree content; a diff against the
      // index then shows the removal, which is exactly what the user wants.
      modified = ''
    }
  }

  return {
    original,
    modified,
    exists: original !== '' || modified !== '',
  }
}

/** Convenience re-export so callers do not import from two places. */
export type { GitFileChange }