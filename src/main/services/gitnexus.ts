import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
  /** The executable path that was found, when available. */
  executablePath?: string | null
}

interface ProcessResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
  /** True when the spawn itself failed because the binary was not found. */
  enoent?: boolean
}

function runBinary(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, `.cmd` and `.bat` shims installed by npm cannot be
      // spawned directly without `shell: true` because Node's spawn does not
      // consult PATHEXT. This is the root cause of "gitnexus CLI not found"
      // on Windows even though `npm install -g gitnexus` succeeded — the
      // package installs `gitnexus.cmd` in `%APPDATA%\npm`, which is on PATH
      // but is not directly executable via `spawn('gitnexus', ...)`.
      shell: process.platform === 'win32',
    })
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
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: false,
        stdout,
        stderr,
        error: error.message,
        enoent: error.code === 'ENOENT',
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
  })
}

/**
 * Windows-specific executable discovery. On Windows, a globally-installed
 * npm package lands in one of two places depending on how Node was set up:
 *
 *   %APPDATA%\npm\gitnexus.cmd       (standard npm prefix on Windows)
 *   %ProgramFiles%\nodejs\gitnexus.cmd (when npm's prefix is the Node dir)
 *
 * The `.cmd` file is a batch shim that forwards to `node ...\gitnexus`.
 * `spawn` cannot execute it directly, and — critically — the `shell: true`
 * workaround above only works if `gitnexus` is already resolvable through
 * the shell's PATH. In practice, Electron launched from a shortcut inherits
 * a PATH that may not include `%APPDATA%\npm`, which is why the wrapper
 * probes these well-known locations directly and reports the executable
 * path in the status so the UI can show it.
 *
 * On non-Windows platforms this returns null and the caller falls back to
 * a bare `gitnexus` on PATH, which is the correct behaviour for a
 * globally-installed npm package on macOS and Linux.
 */
async function findWindowsGitNexus(): Promise<string | null> {
  if (process.platform !== 'win32') return null

  const candidates: string[] = []

  const appData = process.env.APPDATA
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'gitnexus.cmd'))
    candidates.push(path.join(appData, 'npm', 'gitnexus'))
    candidates.push(path.join(appData, 'npm', 'gitnexus.ps1'))
  }

  const programFiles = process.env.ProgramFiles
  if (programFiles) {
    candidates.push(path.join(programFiles, 'nodejs', 'gitnexus.cmd'))
  }

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    // nvm-windows and fnm install shims here.
    candidates.push(path.join(localAppData, 'nvm', 'gitnexus.cmd'))
    candidates.push(path.join(localAppData, 'fnm_multishells', 'gitnexus.cmd'))
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

let cachedStatus: GitNexusStatus | null = null

/**
 * Probe for a `gitnexus` binary on PATH. Cached for the lifetime of the
 * process: the answer does not change while the app runs, and each probe
 * spawns a subprocess.
 */
export async function checkGitNexus(): Promise<GitNexusStatus> {
  if (cachedStatus) return cachedStatus

  // On Windows, look for the npm shim in its well-known locations first.
  // A bare `gitnexus` spawn will find it if PATH includes `%APPDATA%\npm`,
  // but an Electron process started from a shortcut frequently has a
  // narrower PATH than a terminal session, and the shim is a `.cmd` file
  // that needs `shell: true` regardless. Probing the filesystem gives us a
  // concrete path to hand to `spawn`, which works in both environments.
  const windowsPath = await findWindowsGitNexus()
  const command = windowsPath ?? 'gitnexus'

  const result = await runBinary(command, ['--version'], process.cwd(), 5000)
  if (result.ok) {
    cachedStatus = {
      available: true,
      version: result.stdout.trim() || null,
      reason: null,
      executablePath: windowsPath,
    }
  } else {
    // A successful installation on Windows that the wrapper still cannot
    // spawn produces ENOENT on the `error` event. The reason string below
    // is what the UI shows next to "gitnexus CLI not found" — make it
    // actionable by naming the platform-specific cause instead of echoing
    // the bare Node error message.
    let reason: string
    if (result.enoent && process.platform === 'win32') {
      reason =
        'gitnexus was not found. `npm install -g gitnexus` should place a ' +
        'shim at %APPDATA%\\npm\\gitnexus.cmd — check that this file exists ' +
        'and that %APPDATA%\\npm is on PATH for the process that launched ' +
        'the app. If you installed with a Node version manager (nvm, fnm), ' +
        're-open the app after activating the same Node version in a ' +
        'terminal.'
    } else if (result.enoent) {
      reason =
        'gitnexus is not installed or is not on PATH. Install it with ' +
        '`npm install -g gitnexus`.'
    } else {
      reason =
        result.error ??
        result.stderr.trim() ??
        'gitnexus is not installed or is not on PATH.'
    }
    cachedStatus = {
      available: false,
      version: null,
      reason,
      executablePath: null,
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

  // Use the same resolved path the probe found. On Windows this is the
  // concrete `gitnexus.cmd` location; on other platforms it falls back to
  // the bare name, which is what a global npm install puts on PATH.
  const command = status.executablePath ?? 'gitnexus'

  const result = await runBinary(
    command,
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