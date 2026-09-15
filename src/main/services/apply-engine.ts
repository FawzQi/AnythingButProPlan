import type { ApplyRequest, ApplyResult, DiffResult } from '@shared/types'
import { fileExists, readTextFile, resolveWithinRoot, writeFileWithBackup } from './fs-service'

/**
 * Read the on-disk and proposed versions of a file so the UI can render a diff.
 * A file that does not exist yet comes back with an empty original.
 */
export async function computeDiff(
  projectRoot: string,
  relativePath: string,
  proposed: string,
): Promise<DiffResult> {
  resolveWithinRoot(projectRoot, relativePath)
  const exists = await fileExists(projectRoot, relativePath)
  const original = exists ? await readTextFile(projectRoot, relativePath) : ''
  return { original, modified: proposed, exists }
}

/**
 * Write the confirmed files. Every path is re-validated here even though the
 * renderer already checked it — the renderer is not a trust boundary.
 *
 * A failure on one file never rolls back the others; each result is reported
 * and the user decides what to do next.
 */
export async function applyFiles(request: ApplyRequest): Promise<ApplyResult[]> {
  const results: ApplyResult[] = []

  for (const file of request.files) {
    if (file.path === null || file.path === '') {
      results.push({ path: file.path ?? '', status: 'failed', error: 'No target path.' })
      continue
    }
    try {
      const outcome = await writeFileWithBackup(request.projectRoot, file.path, file.content)
      results.push({
        path: file.path,
        status: outcome.status,
        ...(outcome.backupPath === undefined ? {} : { backupPath: outcome.backupPath }),
      })
    } catch (error) {
      results.push({
        path: file.path,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}
