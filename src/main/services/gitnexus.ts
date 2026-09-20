import { spawn } from 'node:child_process'

/**
 * Thin wrapper around the `gitnexus` CLI.
 *
 * GitNexus is an external tool the user installs themselves; it is not
 * bundled. The selector calls it as a subprocess to answer "which symbols
 * are structurally related to these terms?" — a graph query over the
 * repository's symbol table that a pure text search cannot reproduce.
 *
 * The CLI contract this wrapper expects:
 *
 *   gitnexus --version
 *     Prints a version string; exit 0 when the binary exists.
 *
 *   gitnexus query --json --limit <n> --terms "<space-separated terms>"
 *     Prints a JSON object on stdout. Two shapes are accepted:
 *       { "results": [ { "path": "...", "score": 0.8, "symbol": "..." }, … ] }
 *       [ { "path": "...", "score": 0.8, "symbol": "..." }, … ]
 *     Paths are project-relative POSIX. `score` is any number; higher wins.
 *
 * If the binary is missing, the query fails, or the JSON shape is
 * unrecognised, the wrapper returns an empty array rather than throwing.
 * The selector treats an empty GitNexus result as "fall back to BM25" —
 * that is the documented behaviour of the pipeline, so a missing tool
 * degrades gracefully instead of blocking the feature.
 */

export interface GitNexusHit {
  path: string
  score: number
  symbol?: string
}

export interface GitNexusStatus {
  available: boolean
  version: string | null
  reason: string | null
}

interface ProcessResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

function runBinary(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({
        ok: false,
        stdout,
        stderr,
        error: `gitnexus did not respond within ${timeoutMs} ms.`,
      })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
  })
}

let cachedStatus: GitNexusStatus | null = null

/**
 * Probe for a `gitnexus` binary on PATH. Cached for the lifetime of the
 * process: the answer does not change while the app runs, and each probe
 * spawns a subprocess.
 */
export async function checkGitNexus(): Promise<GitNexusStatus> {
  if (cachedStatus) return cachedStatus
  const result = await runBinary('gitnexus', ['--version'], process.cwd(), 5000)
  if (result.ok) {
    cachedStatus = {
      available: true,
      version: result.stdout.trim() || null,
      reason: null,
    }
  } else {
    cachedStatus = {
      available: false,
      version: null,
      reason:
        result.error ??
        result.stderr.trim() ??
        'gitnexus is not installed or is not on PATH.',
    }
  }
  return cachedStatus
}

export async function queryGitNexus(
  root: string,
  terms: string[],
  limit = 60,
): Promise<GitNexusHit[]> {
  const cleaned = terms.map((term) => term.trim()).filter((term) => term !== '')
  if (cleaned.length === 0) return []
  const status = await checkGitNexus()
  if (!status.available) return []

  const result = await runBinary(
    'gitnexus',
    [
      'query',
      '--json',
      '--limit',
      String(limit),
      '--terms',
      cleaned.join(' '),
    ],
    root,
    20_000,
  )
  if (!result.ok) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return []
  }
  return extractHits(parsed)
}

function extractHits(parsed: unknown): GitNexusHit[] {
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : []

  const hits: GitNexusHit[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const rawPath = typeof record.path === 'string' ? record.path : null
    if (!rawPath) continue
    const score =
      typeof record.score === 'number' && Number.isFinite(record.score)
        ? record.score
        : 1
    const symbol =
      typeof record.symbol === 'string' ? record.symbol : undefined
    hits.push({ path: rawPath.replace(/\\/g, '/'), score, symbol })
  }
  return hits
}