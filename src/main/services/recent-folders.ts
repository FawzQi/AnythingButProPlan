import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RecentFolder } from '@shared/types'

/**
 * Persist the list of folders the user has opened, so a project can be
 * re-opened without going through the native picker every time.
 *
 * The list is a convenience, not a project registry. It is capped at ten
 * entries, ordered most-recently-opened first, and pruned on read of any
 * path that no longer exists on disk — the alternative (letting the user
 * click a saved entry that fails to scan) surfaces an error banner for what
 * is really just a stale shortcut.
 *
 * Storage is a plain JSON file under `userData`, separate from
 * `ai-settings.json`. The two have nothing in common — one holds
 * encrypted credentials, the other holds folder paths — and a corrupt
 * recent list must never be able to take the API keys down with it.
 */

const MAX_RECENT = 10

interface StoredShape {
  folders: RecentFolder[]
}

function storagePath(): string {
  return path.join(app.getPath('userData'), 'recent-folders.json')
}

function defaultLabel(folderPath: string): string {
  const base = path.basename(folderPath)
  // `path.basename('C:\\')` returns the empty string; fall back to the raw
  // path so a drive root still has a clickable label.
  return base === '' ? folderPath : base
}

/**
 * Read and sanitise the on-disk list. A missing or unreadable file yields an
 * empty list rather than an error: the user cannot be blocked from opening a
 * folder because a shortcut file went missing.
 */
async function readStored(): Promise<StoredShape> {
  try {
    const raw = await fs.readFile(storagePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredShape>
    if (!Array.isArray(parsed.folders)) return { folders: [] }
    const folders: RecentFolder[] = []
    for (const entry of parsed.folders) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const folderPath = typeof record.path === 'string' ? record.path : ''
      if (folderPath === '' || folderPath.includes('\0')) continue
      folders.push({
        path: folderPath,
        label:
          typeof record.label === 'string' && record.label !== ''
            ? record.label
            : defaultLabel(folderPath),
        lastOpenedAt:
          typeof record.lastOpenedAt === 'number' ? record.lastOpenedAt : 0,
      })
    }
    folders.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    return { folders: folders.slice(0, MAX_RECENT) }
  } catch {
    return { folders: [] }
  }
}

async function writeStored(shape: StoredShape): Promise<void> {
  const file = storagePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(shape, null, 2), 'utf8')
}

/**
 * Return the saved folders, in most-recent-first order. Paths that no longer
 * exist are dropped here rather than surfaced as broken entries; the pruned
 * list is written back so the next read is a no-op.
 */
export async function listRecentFolders(): Promise<RecentFolder[]> {
  const stored = await readStored()
  const alive: RecentFolder[] = []
  for (const folder of stored.folders) {
    try {
      const stat = await fs.stat(folder.path)
      if (stat.isDirectory()) alive.push(folder)
    } catch {
      // Missing or inaccessible. Dropped from the list.
    }
  }
  if (alive.length !== stored.folders.length) {
    await writeStored({ folders: alive })
  }
  return alive
}

/**
 * Move `folderPath` to the top of the list (adding it if new) and return the
 * updated list. Called automatically every time a folder is opened — from
 * the native picker or from the recent menu itself — so the order tracks
 * usage without a separate "save" step.
 */
export async function addRecentFolder(
  folderPath: string,
): Promise<RecentFolder[]> {
  const trimmed = folderPath.trim()
  if (trimmed === '') return listRecentFolders()

  const stored = await readStored()
  const existing = stored.folders.find((folder) => folder.path === trimmed)
  const entry: RecentFolder = existing
    ? { ...existing, lastOpenedAt: Date.now() }
    : {
        path: trimmed,
        label: defaultLabel(trimmed),
        lastOpenedAt: Date.now(),
      }
  const next = [
    entry,
    ...stored.folders.filter((folder) => folder.path !== trimmed),
  ].slice(0, MAX_RECENT)
  await writeStored({ folders: next })
  return next
}

/** Remove one saved folder. No-op when it is not in the list. */
export async function removeRecentFolder(
  folderPath: string,
): Promise<RecentFolder[]> {
  const stored = await readStored()
  const next = stored.folders.filter((folder) => folder.path !== folderPath)
  await writeStored({ folders: next })
  return next
}

/** Remove every saved folder. */
export async function clearRecentFolders(): Promise<RecentFolder[]> {
  await writeStored({ folders: [] })
  return []
}