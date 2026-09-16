import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import sanitizeFilename from 'sanitize-filename'
import type { FileNode, ScanResult } from '@shared/types'

/** Directories that are never worth prompting over. */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  'venv',
  '.venv',
  'target',
  'bin',
  'obj',
  '.next',
  '.cache',
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.svgz', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib', '.class', '.pyc', '.pyo',
  '.wasm', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.psd', '.ai', '.sketch', '.blend', '.lockb',
])

export function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Turn a project-relative path into an absolute one, refusing anything that
 * escapes the project root. Every write and every read of AI-supplied paths
 * funnels through here — this is the single traversal guard.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new Error(`Illegal path: ${relativePath}`)
  }

  const normalizedRoot = path.resolve(root)
  const absolute = path.resolve(normalizedRoot, relativePath)
  const withSeparator = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep
  if (absolute !== normalizedRoot && !absolute.startsWith(withSeparator)) {
    throw new Error(`Path escapes the project root: ${relativePath}`)
  }

  // Reject rather than rewrite: a silently renamed AI path would write the
  // file somewhere the model did not ask for. This catches the names Linux
  // accepts but Windows cannot create (CON, NUL, trailing dots, `:`).
  for (const segment of relativePath.split('/')) {
    if (segment === '') continue
    if (sanitizeFilename(segment) !== segment) {
      throw new Error(`Path is not portable across platforms: ${relativePath}`)
    }
  }

  return absolute
}

async function loadGitignore(root: string): Promise<Ignore> {
  const matcher = ignore()
  try {
    const contents = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    matcher.add(contents)
  } catch {
    // No .gitignore is normal, not an error.
  }
  return matcher
}

export async function isBinaryFile(absolutePath: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) return true
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(absolutePath, 'r')
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return true
  } finally {
    await handle?.close()
  }
}

interface WalkState {
  root: string
  matcher: Ignore
  fileCount: number
  skippedCount: number
}

async function walk(absoluteDir: string, relativeDir: string, state: WalkState): Promise<FileNode[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true })
  } catch {
    return []
  }

  const directories: FileNode[] = []
  const files: FileNode[] = []

  for (const entry of entries) {
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    const absolute = path.join(absoluteDir, entry.name)
    const posixRelative = toPosix(relative)

    if (entry.isSymbolicLink()) {
      state.skippedCount += 1
      continue
    }

    if (entry.isDirectory()) {
      if (ALWAYS_SKIP.has(entry.name) || state.matcher.ignores(`${posixRelative}/`)) {
        state.skippedCount += 1
        continue
      }
      const children = await walk(absolute, relative, state)
      if (children.length === 0) continue
      directories.push({
        id: posixRelative,
        name: entry.name,
        path: posixRelative,
        type: 'directory',
        children,
        selected: false,
        expanded: relativeDir === '',
      })
      continue
    }

    if (!entry.isFile()) continue
    if (ALWAYS_SKIP.has(entry.name) || state.matcher.ignores(posixRelative)) {
      state.skippedCount += 1
      continue
    }
    if (await isBinaryFile(absolute)) {
      state.skippedCount += 1
      continue
    }

    let size: number | undefined
    try {
      size = (await fs.stat(absolute)).size
    } catch {
      size = undefined
    }

    state.fileCount += 1
    files.push({
      id: posixRelative,
      name: entry.name,
      path: posixRelative,
      type: 'file',
      selected: false,
      expanded: false,
      size,
    })
  }

  const byName = (a: FileNode, b: FileNode): number => a.name.localeCompare(b.name)
  return [...directories.sort(byName), ...files.sort(byName)]
}

/** Recursively scan a project root, honouring .gitignore and the skip list. */
export async function scanDirectory(root: string): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root)
  const matcher = await loadGitignore(absoluteRoot)
  const state: WalkState = { root: absoluteRoot, matcher, fileCount: 0, skippedCount: 0 }
  const children = await walk(absoluteRoot, '', state)

  return {
    root: absoluteRoot,
    tree: {
      id: '',
      name: path.basename(absoluteRoot) || absoluteRoot,
      path: '',
      type: 'directory',
      children,
      selected: false,
      expanded: true,
    },
    fileCount: state.fileCount,
    skippedCount: state.skippedCount,
  }
}

export async function readTextFile(root: string, relativePath: string): Promise<string> {
  return fs.readFile(resolveWithinRoot(root, relativePath), 'utf8')
}

export async function fileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await fs.stat(resolveWithinRoot(root, relativePath))
    return true
  } catch {
    return false
  }
}

/** Write an arbitrary file (used for "save prompt as"), creating parents. */
export async function writeFileEnsuringDir(absolutePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, content, 'utf8')
}

export interface WriteOutcome {
  status: 'created' | 'overwritten' | 'skipped'
  backupPath?: string
}

/** `20250914T120000` — collision suffix for a .bak that already exists. */
export function backupTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
}

/**
 * Write one project-relative file, backing up any existing version first and
 * renaming into place so a crash cannot leave a half-written file.
 *
 * Content is written byte-for-byte as given; nothing is normalized.
 */
export async function writeFileWithBackup(
  root: string,
  relativePath: string,
  content: string,
): Promise<WriteOutcome> {
  const absolute = resolveWithinRoot(root, relativePath)

  let existing: string | null = null
  try {
    existing = await fs.readFile(absolute, 'utf8')
  } catch {
    // Nothing on disk yet — `existing` stays null and no backup is written.
  }

  if (existing === content) {
    return { status: 'skipped' }
  }

  await fs.mkdir(path.dirname(absolute), { recursive: true })

  let backupPath: string | undefined
  if (existing !== null) {
    const candidate = `${absolute}.bak`
    let target = candidate
    try {
      await fs.access(candidate)
      target = `${candidate}.${backupTimestamp()}`
    } catch {
      // No previous backup — the plain .bak name is free.
    }
    await fs.copyFile(absolute, target)
    backupPath = toPosix(path.relative(path.resolve(root), target))
  }

  // Preferred path: write to a sibling temp file and rename into place so a
  // crash mid-write cannot leave a truncated file.
  //
  // The rename is the fragile half on Windows — `MoveFileEx` with
  // REPLACE_EXISTING is refused with EPERM/EBUSY when the destination is
  // briefly locked by an indexer, an antivirus scan, or another handle that
  // has not yet been released. Since the alternative is losing the user's
  // save entirely, fall back to a direct in-place write whenever either the
  // temp write or the rename fails.
  const temporary = `${absolute}.tmp`
  try {
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, absolute)
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    await fs.writeFile(absolute, content, 'utf8')
  }

  return backupPath === undefined
    ? { status: 'created' }
    : { status: 'overwritten', backupPath }
}
