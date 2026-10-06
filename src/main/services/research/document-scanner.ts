import { promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ConversionMode,
  DocumentEntry,
  DocumentStatus,
  IndexStatus,
  ResearchScanResult,
} from '@shared/types'
import { resolveWithinRoot, toPosix, writeFileEnsuringDir } from '../core/fs-service'

/**
 * The document side of research mode: find what is in `docs/`, remember what
 * has been converted, and report the state of the retrieval index.
 *
 * Layout, all of it under the project root:
 *
 *   docs/                     the user's source documents (never touched)
 *   converted/.state.json     one record per document, keyed by slug
 *   converted/<slug>/<slug>.md
 *   converted/<slug>/meta.json      per-image analysis cache (vision pass)
 *   converted/<slug>/images/        only in `text-images` mode
 *   .index/                   chunks + vectors, rebuilt independently
 *
 * The `converted/` tree is flat and keyed by slug rather than mirroring the
 * `docs/` hierarchy. The reason is the state file: a nested tree would need
 * a nested state file, or a slug lookup that walks it on every read, and the
 * only thing the hierarchy buys is a nicer folder listing for a directory
 * the user is told to gitignore anyway.
 */

/** Files the converter can read. Anything else is reported as unsupported. */
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt'])

/** Extensions whose text extraction runs through a subprocess. */
export const PDF_EXTENSIONS = new Set(['.pdf'])

export function isSupportedDocument(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

export function docsRoot(projectRoot: string): string {
  return path.join(projectRoot, 'docs')
}

export function convertedRoot(projectRoot: string): string {
  return path.join(projectRoot, 'converted')
}

export function indexPath(projectRoot: string): string {
  return path.join(projectRoot, '.index')
}

export function slugFor(relativePath: string): string {
  const parsed = path.parse(relativePath)
  const directory = parsed.dir === '' ? '' : `${parsed.dir.replace(/[/\\]/g, '-')}-`
  const base = `${directory}${parsed.name}`
    .toLowerCase()
    // Keep the slug readable — it is the folder name the user sees — and
    // append a short hash so two documents named `intro.pdf` in different
    // folders (or one document with characters that sanitise to nothing)
    // cannot collide on the same directory.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const hash = createHash('sha1')
    .update(toPosix(relativePath))
    .digest('hex')
    .slice(0, 6)
  return base === '' ? hash : `${base}-${hash}`
}

/** One document's record in `converted/.state.json`. */
interface StateRecord {
  path: string
  status: DocumentStatus
  mode?: ConversionMode
  convertedAt?: number
  imageAnalyzed?: boolean
  visionProvider?: DocumentEntry['visionProvider']
  chunkCount?: number
  error?: string
}

type StateFile = Record<string, StateRecord>

/**
 * The state file is app-owned metadata, not a source file: it is written
 * outside the apply engine's backup/conflict machinery, and a corrupt one is
 * recoverable (the documents themselves are untouched). So this reads
 * tolerantly and rebuilds from nothing rather than failing the scan — a
 * research project with an unreadable state file should still list its
 * documents.
 */
export async function readState(projectRoot: string): Promise<StateFile> {
  try {
    const raw = await fs.readFile(
      path.join(convertedRoot(projectRoot), '.state.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const state: StateFile = {}
    for (const [slug, value] of Object.entries(parsed as StateFile)) {
      if (value === null || typeof value !== 'object') continue
      if (typeof value.path !== 'string') continue
      state[slug] = {
        path: value.path,
        status:
          value.status === 'converted' || value.status === 'failed'
            ? value.status
            : 'ready',
        mode: value.mode === 'text-images' ? 'text-images' : value.mode === 'text' ? 'text' : undefined,
        convertedAt:
          typeof value.convertedAt === 'number' ? value.convertedAt : undefined,
        imageAnalyzed: value.imageAnalyzed === true ? true : undefined,
        visionProvider:
          typeof value.visionProvider === 'string'
            ? value.visionProvider
            : undefined,
        chunkCount:
          typeof value.chunkCount === 'number' ? value.chunkCount : undefined,
        error: typeof value.error === 'string' ? value.error : undefined,
      }
    }
    return state
  } catch {
    return {}
  }
}

export async function writeState(
  projectRoot: string,
  state: StateFile,
): Promise<void> {
  await writeFileEnsuringDir(
    path.join(convertedRoot(projectRoot), '.state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

/** Update one record and persist the whole file. */
export async function recordDocument(
  projectRoot: string,
  slug: string,
  record: StateRecord,
): Promise<void> {
  const state = await readState(projectRoot)
  state[slug] = record
  await writeState(projectRoot, state)
}

export function markdownPathFor(
  projectRoot: string,
  slug: string,
): string {
  return path.join(convertedRoot(projectRoot), slug, `${slug}.md`)
}

/**
 * Where the documents actually live.
 *
 * `docs/` when it exists — that is the layout the rest of the app documents,
 * and the one that keeps `converted/` and `.index/` away from the user's own
 * files. When there is no `docs/`, the project root is used instead: opening
 * a folder full of PDFs and being told there is nothing to convert, with the
 * PDFs visibly sitting right there, reads as a broken app rather than as a
 * missing subdirectory.
 *
 * The fallback is deliberately narrower than the `docs/` scan — see
 * `listDocuments`.
 */
export function documentsRoot(projectRoot: string): string {
  try {
    return statSync(docsRoot(projectRoot)).isDirectory()
      ? docsRoot(projectRoot)
      : projectRoot
  } catch {
    return projectRoot
  }
}

/**
 * Directories that must never be walked when the scan starts at the project
 * root. `node_modules` is the important one — it is full of README.md files,
 * and a fallback scan that listed them would bury the user's actual PDFs
 * under thousands of package readmes.
 */
const ROOT_SCAN_SKIP = new Set(['node_modules', 'converted', '.index', 'dist', 'out', 'release'])

/**
 * Files to treat as documents, recursively, with POSIX-relative paths.
 *
 * In `docs/` mode everything is listed — an unsupported file is reported as
 * `failed` rather than hidden, because a file the user can see in the folder
 * must appear in the list. In root mode only supported document types are
 * listed: the project root is a code repository far more often than it is a
 * document set, and listing every `.ts` file as an unsupported document would
 * make the panel useless.
 */
async function listDocuments(
  projectRoot: string,
  rootMode: boolean,
): Promise<string[]> {
  const root = rootMode ? projectRoot : docsRoot(projectRoot)
  const found: string[] = []

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // Dotfiles and dot-directories are skipped: `.DS_Store`, editor
      // backups, and the `.git` a user might keep in `docs/` are not
      // documents, and listing them as failures would be noise.
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (rootMode && ROOT_SCAN_SKIP.has(entry.name)) continue
        await walk(path.join(absolute, entry.name), relative)
      } else if (entry.isFile()) {
        if (rootMode && !isSupportedDocument(entry.name)) continue
        found.push(relative)
      }
    }
  }

  await walk(root, '')
  return found.sort()
}

export async function readIndexStatus(
  projectRoot: string,
): Promise<IndexStatus> {
  const empty: IndexStatus = {
    built: false,
    documentCount: 0,
    chunkCount: 0,
    dimensions: 0,
    model: null,
    builtAt: null,
  }
  try {
    const raw = await fs.readFile(
      path.join(indexPath(projectRoot), 'meta.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as Partial<IndexStatus>
    return {
      built: (parsed.chunkCount ?? 0) > 0,
      documentCount: parsed.documentCount ?? 0,
      chunkCount: parsed.chunkCount ?? 0,
      dimensions: parsed.dimensions ?? 0,
      model: typeof parsed.model === 'string' ? parsed.model : null,
      builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : null,
    }
  } catch {
    return empty
  }
}

/**
 * List every file under `docs/` joined with its conversion record.
 *
 * A file that is not a supported format is reported as `failed` with the
 * reason, at scan time, rather than being filtered out of the list. A
 * document the user can see in `docs/` but not in the app is the one outcome
 * that must not happen — it reads as "the app lost my file".
 */
export async function scanDocuments(
  projectRoot: string,
): Promise<ResearchScanResult> {
  const index = await readIndexStatus(projectRoot)
  let docsDirExists: boolean
  try {
    docsDirExists = (await fs.stat(docsRoot(projectRoot))).isDirectory()
  } catch {
    docsDirExists = false
  }

  const rootMode = !docsDirExists
  const state = await readState(projectRoot)
  const files = await listDocuments(projectRoot, rootMode)
  const documents: DocumentEntry[] = []

  for (const relativePath of files) {
    const slug = slugFor(relativePath)
    const record = state[slug]
    let sizeBytes = 0
    try {
      const stat = await fs.stat(
        resolveWithinRoot(documentsRoot(projectRoot), relativePath),
      )
      sizeBytes = stat.size
    } catch {
      // A file that vanished between the listing and the stat is reported
      // with size 0 rather than skipped — the next scan drops it.
    }

    const supported = isSupportedDocument(relativePath)
    const convertedExists = await fileExistsQuiet(
      markdownPathFor(projectRoot, slug),
    )

    const status: DocumentStatus = !supported
      ? 'failed'
      : record?.status === 'converted' && convertedExists
        ? 'converted'
        : record?.status === 'failed'
          ? 'failed'
          : 'ready'

    documents.push({
      path: relativePath,
      slug,
      sizeBytes,
      status,
      mode: record?.mode,
      convertedAt: record?.convertedAt,
      imageAnalyzed: record?.imageAnalyzed,
      visionProvider: record?.visionProvider,
      chunkCount: record?.chunkCount,
      // A record's own error wins: a document that failed a conversion has
      // something more specific to say than "this format is not local", and
      // masking it with the format hint would erase the reason the last
      // attempt failed.
      error:
        record?.error ??
        (!supported
          ? `Unsupported format — only ${[...SUPPORTED_EXTENSIONS].join(', ')} files are converted.`
          : undefined),
      convertedExists,
    })
  }

  return {
    docsDirExists,
    sourceDir: rootMode ? 'root' : 'docs',
    documents,
    index,
  }
}

async function fileExistsQuiet(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath)
    return true
  } catch {
    return false
  }
}

/**
 * Phase 9 housekeeping: make sure `converted/` and `.index/` are ignored.
 *
 * Both directories are derived data — a rebuild costs provider calls but
 * nothing is lost — and `converted/` in particular holds extracted images
 * that would otherwise land in the user's commits. The append is idempotent
 * and reported through the scan result's caller, not done silently: the
 * function returns whether it changed anything so the UI can say so once.
 */
export async function ensureGitignore(projectRoot: string): Promise<boolean> {
  const gitignore = path.join(projectRoot, '.gitignore')
  const entries = ['converted/', '.index/']
  let current = ''
  try {
    current = await fs.readFile(gitignore, 'utf8')
  } catch {
    // No .gitignore is the common case for a fresh research folder.
  }
  const missing = entries.filter(
    (entry) => !current.split(/\r?\n/).some((line) => line.trim() === entry),
  )
  if (missing.length === 0) return false
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`
  await writeFileEnsuringDir(
    gitignore,
    `${prefix}\n# Research mode derived data — rebuildable, not source.\n${missing.join('\n')}\n`,
  )
  return true
}
