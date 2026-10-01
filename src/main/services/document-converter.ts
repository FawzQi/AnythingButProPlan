import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  ConversionMode,
  ConvertProgress,
  ConvertResult,
  DocumentEntry,
  ExtractionEngine,
  WebChatTargetId,
} from '@shared/types'
import { visionProviderOption } from '@shared/vision-providers'
import { isChatConvertible } from '@shared/chat-formats'
import { isCancelled } from './cancellation'
import {
  convertedRoot,
  documentsRoot,
  isSupportedDocument,
  markdownPathFor,
  PDF_EXTENSIONS,
  readState,
  scanDocuments,
  slugFor,
  writeState,
} from './document-scanner'
import { analyzeImages } from './image-analyzer'
import { convertDocumentsViaWebChat } from './webchat-converter'
import { sendDocumentToWebChat } from './web-chat'
import { resolveWithinRoot, writeFileEnsuringDir } from './fs-service'

/**
 * Document → markdown conversion.
 *
 * The `auto` engine (the default) runs the Docling CLI inside its own
 * virtualenv. Docling applies a real layout model to each page on the GPU,
 * so figures, charts and two-column layouts survive the conversion — the
 * reason the old API engine existed — without sending the document to a
 * third party, and without Marker's multi-GB model download and multi-minute
 * CPU run. Docling embeds each extracted figure inline as base64; a Python
 * wrapper (`docling_to_markdown.py`) turns those into real image files under
 * the document's output folder before the vision pass runs, so `text-images`
 * mode has files to describe with the API LLM.
 *
 * Two other engines remain:
 *
 *   - `fast` — a bundled Python script (pdftext, with a pypdfium2 fallback)
 *     that runs entirely offline. Text-only, no figures, and two-column
 *     papers come out interleaved. It is the fallback when Docling is not
 *     installed and the offline path the user can pick deliberately.
 *
 *   - `webchat` — attaches the PDF to a web chat window and reads the reply
 *     back from the site's own UI. Routed to `webchat-converter.ts` before
 *     any of the local machinery runs.
 *
 * The `auto` engine value is kept as the name of "the default engine"; it
 * now means Docling, not a chat API call.
 */

/** Docling loads a layout model; a hung run is minutes, not hours. */
const DOCLING_TIMEOUT_MS = 10 * 60_000

/** PyMuPDF4LLM is a pure text pass; anything near this means it hung. */
const PYTHON_TIMEOUT_MS = 3 * 60_000

/**
 * Docling lives in its own virtualenv — it pulls torch and a layout model,
 * which do not belong in the app's interpreter. The wrapper script is run
 * with that venv's python, so `docling` sits beside it and the venv the app
 * was pointed at is the venv that actually ran. Overridable so a machine
 * where the venv lives elsewhere does not need a code change.
 */
const DOCLING_VENV = process.env.DOCLING_VENV ?? '/data/docling-env'

/**
 * Device Docling runs the layout model on. CUDA by default — the model is
 * the whole reason this engine exists, and it is many times faster on a
 * GPU. A machine without one can point this at `cpu` or `auto` without a
 * code change.
 */
const DOCLING_DEVICE = process.env.DOCLING_DEVICE ?? 'cuda'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  missing: boolean
}

/**
 * Run a child process to completion, capturing both streams.
 *
 * `missing` distinguishes "the tool is not installed" (ENOENT) from "the tool
 * ran and failed", because the two take different recovery paths: the first
 * falls back to the Python extractor, the second is a real extraction
 * failure and is reported to the user with the tool's own stderr.
 */
function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: null, stdout, stderr, timedOut: true, missing: false })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut: false,
        missing: error.code === 'ENOENT',
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false, missing: false })
    })
  })
}

function pythonScriptPath(): string {
  // Dev runs from the repo; a packaged build gets the script through
  // `extraResources` in package.json, which lands it beside `app.asar`
  // rather than inside it — a Python interpreter cannot read into an asar.
  const packaged = path.join(process.resourcesPath ?? '', 'python', 'pdf_to_markdown.py')
  const dev = path.join(app.getAppPath(), 'resources', 'python', 'pdf_to_markdown.py')
  return app.isPackaged ? packaged : dev
}

function doclingScriptPath(): string {
  // Same layout rule as the fast extractor: the wrapper script travels with
  // the app and is spawned from a real path outside the asar.
  const packaged = path.join(process.resourcesPath ?? '', 'python', 'docling_to_markdown.py')
  const dev = path.join(app.getAppPath(), 'resources', 'python', 'docling_to_markdown.py')
  return app.isPackaged ? packaged : dev
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath)
    return true
  } catch {
    return false
  }
}

/** Recursively find a file by extension anywhere under `root`. */
async function findFirstWithExtension(
  root: string,
  extension: string,
): Promise<string | null> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = await findFirstWithExtension(absolute, extension)
      if (found !== null) return found
    } else if (path.extname(entry.name).toLowerCase() === extension) {
      return absolute
    }
  }
  return null
}

async function copyDirectory(source: string, destination: string): Promise<number> {
  let copied = 0
  let entries
  try {
    entries = await fs.readdir(source, { withFileTypes: true })
  } catch {
    return 0
  }
  await fs.mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      copied += await copyDirectory(from, to)
    } else {
      await fs.copyFile(from, to)
      copied += 1
    }
  }
  return copied
}

/**
 * The result of one extraction. A tagged union rather than an optional
 * `failed` field: the two shapes are mutually exclusive, and a tag makes
 * the consumer's branch exhaustive without relying on `'failed' in ...`.
 */
type Extraction =
  | {
      ok: true
      markdown: string
      /** Absolute path of the extractor's image directory, when it made one. */
      imagesDir: string | null
      /** Warning to surface to the user, e.g. the fallback's layout caveat. */
      warning?: string
      /** Which extractor produced the markdown, recorded for reproducibility. */
      extractor: 'docling' | 'fast' | 'passthrough'
    }
  | { ok: false; reason: string }

/** Text files need no extraction; they are already markdown-ish. */
async function readPlainText(absolutePath: string): Promise<Extraction> {
  return {
    ok: true,
    markdown: await fs.readFile(absolutePath, 'utf8'),
    imagesDir: null,
    extractor: 'passthrough',
  }
}

/**
 * The end of a process's output, not the beginning.
 *
 * A Python traceback puts the useful line last — `RuntimeError: ...` — and
 * the first 300 characters are `Traceback (most recent call last)` followed
 * by click's own frames. Reporting the head of that output is how a failure
 * message ends up telling the user nothing about the failure.
 */
function tail(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `…${trimmed.slice(trimmed.length - limit)}`
}

/**
 * The fast engine: pdftext (a CPU text extractor) with a pypdfium2 fallback,
 * both driven by `resources/python/pdf_to_markdown.py`. Seconds per paper.
 * No figures.
 */
async function extractFast(
  absolutePath: string,
  workDir: string,
): Promise<Extraction> {
  const script = pythonScriptPath()
  if (!(await exists(script))) {
    return {
      ok: false,
      reason: `Fast extractor script is missing at ${script}. Reinstall the app, or switch to the Docling engine.`,
    }
  }
  const result = await run(
    'python3',
    [script, absolutePath, workDir],
    PYTHON_TIMEOUT_MS,
  )
  if (result.missing) {
    return {
      ok: false,
      reason:
        'python3 is not available. Install Python 3 (the extractor needs pdftext or pypdfium2), or switch to the Docling engine.',
    }
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: `The fast extractor timed out after ${Math.round(PYTHON_TIMEOUT_MS / 60_000)} minutes.`,
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: `The fast extractor failed: ${tail(result.stderr, 300) || `exit code ${String(result.code)}`}`,
    }
  }
  const markdownPath = await findFirstWithExtension(workDir, '.md')
  if (markdownPath === null) {
    return { ok: false, reason: 'The fast extractor produced no markdown.' }
  }
  // Which backend ran changes how a two-column paper reads, so it goes into
  // the warning the user sees rather than staying in the logs.
  const backend = /backend: pypdfium2/.test(result.stdout)
    ? 'pypdfium2 (no layout pass)'
    : 'pdftext'
  return {
    ok: true,
    markdown: await fs.readFile(markdownPath, 'utf8'),
    imagesDir: null,
    extractor: 'fast',
    warning:
      `Converted with the fast extractor (${backend}) — no figures, and two-column papers may be interleaved. ` +
      'Use the Docling engine for figure descriptions or when reading order matters.',
  }
}

/**
 * The default engine: the Docling CLI, run inside its own virtualenv.
 *
 * Docling is the only local engine with a real layout model: reading order,
 * table structure and figure regions come from the model rather than from
 * heuristics, and on CUDA it is fast enough to run per document. The wrapper
 * script (`docling_to_markdown.py`) does the two things the app needs on top
 * of the CLI — it extracts Docling's inline base64 figures to real image
 * files and rewrites the markdown links — and hands the caller a predictable
 * `<workDir>/<stem>.md` plus, when there are figures, `<workDir>/images/`.
 *
 * The venv path is a constant rather than a PATH lookup because Docling
 * cannot live in the app's interpreter: it pulls torch and a layout model,
 * and the user installs it separately. That install location is the one
 * thing the app has to be told about, and `DOCLING_VENV` is how.
 */
async function extractWithDocling(
  absolutePath: string,
  workDir: string,
): Promise<Extraction> {
  const script = doclingScriptPath()
  if (!(await exists(script))) {
    return {
      ok: false,
      reason: `Docling wrapper script is missing at ${script}. Reinstall the app, or switch the extractor to the fast engine.`,
    }
  }
  const venvPython = path.join(DOCLING_VENV, 'bin', 'python3')
  if (!(await exists(venvPython))) {
    return {
      ok: false,
      reason:
        `Docling's virtualenv was not found at ${DOCLING_VENV}. Create it ` +
        `(\`python3 -m venv ${DOCLING_VENV} && ${DOCLING_VENV}/bin/pip install docling\`), ` +
        `set DOCLING_VENV to its root, or switch the extractor to the fast engine.`,
    }
  }
  const result = await run(
    venvPython,
    [script, absolutePath, workDir, '--device', DOCLING_DEVICE],
    DOCLING_TIMEOUT_MS,
  )
  if (result.missing) {
    return {
      ok: false,
      reason: `Docling's venv python is not executable at ${venvPython}.`,
    }
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: `Docling timed out after ${Math.round(DOCLING_TIMEOUT_MS / 60_000)} minutes.`,
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: `Docling failed: ${tail(result.stderr, 300) || `exit code ${String(result.code)}`}`,
    }
  }
  const markdownPath = await findFirstWithExtension(workDir, '.md')
  if (markdownPath === null) {
    return { ok: false, reason: 'Docling produced no markdown.' }
  }
  // The wrapper creates `images/` only when it actually wrote a figure out,
  // so the directory's absence is the honest signal that there is nothing
  // for the vision pass to describe.
  const imagesDir = path.join(workDir, 'images')
  const hasImages = await exists(imagesDir)
  return {
    ok: true,
    markdown: await fs.readFile(markdownPath, 'utf8'),
    imagesDir: hasImages ? imagesDir : null,
    extractor: 'docling',
  }
}

async function extract(
  absolutePath: string,
  relativePath: string,
  workDir: string,
  engine: ExtractionEngine,
): Promise<Extraction> {
  if (!PDF_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return readPlainText(absolutePath)
  }

  if (engine === 'fast') {
    return extractFast(absolutePath, workDir)
  }

  return extractWithDocling(absolutePath, workDir)
}

/**
 * Append the vision descriptions to the converted markdown.
 *
 * The descriptions go under the figure's own line rather than into a
 * separate section, because the markdown the model reads during retrieval is
 * the same file — an image reference with no nearby text is invisible to a
 * retrieval prompt, and the whole point of the pass is that the figure's
 * content becomes retrievable.
 */
function attachImageNotes(
  markdown: string,
  notes: Map<string, string>,
): string {
  if (notes.size === 0) return markdown
  const lines = markdown.split('\n')
  const appended = new Set<string>()
  const out: string[] = []

  for (const line of lines) {
    out.push(line)
    const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(line)
    if (match === null) continue
    const referenced = path.basename(match[1] ?? '')
    const note = notes.get(referenced)
    if (note === undefined || appended.has(referenced)) continue
    appended.add(referenced)
    out.push('', `> **Figure**: ${note}`, '')
  }

  // A figure the extractor saved but never referenced in the text would
  // otherwise be analyzed and then silently dropped from the prompt.
  const unreferenced = [...notes.entries()].filter(
    ([name]) => !appended.has(name),
  )
  if (unreferenced.length > 0) {
    out.push('', '## Figures', '')
    for (const [name, note] of unreferenced) {
      out.push(`- **${name}** — ${note}`)
    }
  }
  return out.join('\n')
}

export interface ConvertOptions {
  projectRoot: string
  docPaths: string[]
  mode: ConversionMode
  /**
   * Which extractor to run. `auto` is the Docling engine (the default);
   * `fast` is the local Python extractor; `webchat` drives a chat site in a
   * browser window instead of running anything locally.
   */
  engine: ExtractionEngine
  /** Chat site the `webchat` engine drives. Unused by the other engines. */
  webChatTarget: WebChatTargetId
  visionProviderId?: DocumentEntry['visionProvider']
  onProgress: (progress: ConvertProgress) => void
}

/**
 * Convert every requested document. Sequential by design: the Docling layout
 * model is GPU-bound, the fast engine is CPU-bound, and the chat sites the
 * `webchat` engine drives rate-limit — running two at once makes all three
 * slower and doubles peak memory.
 */
export async function convertDocuments(
  options: ConvertOptions,
): Promise<ConvertResult> {
  const { projectRoot, mode, onProgress } = options
  // The chat-site engine is not an extractor at all: it needs a browser
  // window, the session the user is signed into, and minutes per document.
  // It is routed to its own module before any of the local machinery runs.
  if (options.engine === 'webchat') {
    return convertDocumentsViaWebChat({
      projectRoot,
      docPaths: options.docPaths,
      target: options.webChatTarget,
      onProgress,
      send: (prompt, absoluteDocumentPath) =>
        sendDocumentToWebChat(options.webChatTarget, prompt, absoluteDocumentPath),
    })
  }

  const engine: ExtractionEngine = options.engine === 'fast' ? 'fast' : 'auto'
  const scan = await scanDocuments(projectRoot)
  const wanted =
    options.docPaths.length === 0
      ? scan.documents.map((document) => document.path)
      : options.docPaths

  const targets = scan.documents.filter((document) =>
    wanted.includes(document.path),
  )
  const failed: { path: string; error: string }[] = []
  let cancelled = false

  const state = await readState(projectRoot)
  const vision = visionProviderOption(options.visionProviderId)
  const workRoot = path.join(convertedRoot(projectRoot), '.work')

  for (const [position, document] of targets.entries()) {
    if (isCancelled(projectRoot)) {
      cancelled = true
      break
    }
    const slug = slugFor(document.path)
    const report = (stage: ConvertProgress['stage'], message: string): void => {
      onProgress({
        path: document.path,
        index: position + 1,
        total: targets.length,
        stage,
        message,
      })
    }

    // The fast engine cannot extract figures — that is a real limitation of
    // running without a layout model, and the honest answer is to refuse
    // rather than produce a document recorded as `text-images` with no
    // descriptions in it. Docling has no such limitation: the layout model
    // finds the figures and the wrapper writes them out.
    if (
      engine === 'fast' &&
      mode === 'text-images' &&
      PDF_EXTENSIONS.has(path.extname(document.path).toLowerCase())
    ) {
      const reason =
        'The fast extractor does not extract figures. Switch the extractor to Docling for a text + figures conversion, or convert in text-only mode.'
      failed.push({ path: document.path, error: reason })
      state[slug] = { path: document.path, status: 'failed', mode, error: reason }
      await writeState(projectRoot, state)
      continue
    }

    // The scanner lists unsupported files as `failed` so the user can see
    // them; converting one would otherwise sail through the plain-text
    // passthrough and turn a CSV into a "converted document".
    if (!isSupportedDocument(document.path)) {
      const reason = isChatConvertible(document.path)
        ? `The local extractors cannot read ${path.extname(document.path)} — switch the extractor to webchat to convert this document.`
        : `Unsupported format — only .pdf, .md and .txt are converted locally.`
      failed.push({ path: document.path, error: reason })
      state[slug] = { path: document.path, status: 'failed', mode, error: reason }
      await writeState(projectRoot, state)
      continue
    }

    const outDir = path.join(convertedRoot(projectRoot), slug)
    const workDir = path.join(workRoot, slug)
    const targetPath = markdownPathFor(projectRoot, slug)
    const absoluteDoc = resolveWithinRoot(
      documentsRoot(projectRoot),
      document.path,
    )

    try {
      report('extracting', `Converting ${path.basename(document.path)}`)
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.mkdir(workDir, { recursive: true })

      const extraction = await extract(
        absoluteDoc,
        document.path,
        workDir,
        engine,
      )
      if (!extraction.ok) {
        throw new Error(extraction.reason)
      }

      await fs.rm(outDir, { recursive: true, force: true })
      await fs.mkdir(outDir, { recursive: true })

      let markdown = extraction.markdown
      let imageCount = 0
      let imageAnalysisError: string | null = null

      if (extraction.imagesDir !== null) {
        imageCount = await copyDirectory(
          extraction.imagesDir,
          path.join(outDir, 'images'),
        )
      }

      if (mode === 'text-images' && imageCount > 0) {
        report(
          'images',
          `Describing ${imageCount} figure(s) with ${vision.label}`,
        )
        try {
          const analyzed = await analyzeImages({
            projectRoot,
            slug,
            imagesDir: path.join(outDir, 'images'),
            providerId: vision.id,
          })
          markdown = attachImageNotes(markdown, analyzed.notes)
        } catch (error) {
          // The text conversion succeeded; only the enrichment failed. Report
          // it on the document and keep the markdown — discarding a good
          // conversion because a vision call failed would be the worse
          // outcome, and the flag stays false so the pass can be re-run.
          imageAnalysisError =
            error instanceof Error ? error.message : String(error)
        }
      }

      report('saving', `Writing ${slug}.md`)
      await writeFileEnsuringDir(targetPath, markdown)

      state[slug] = {
        path: document.path,
        status: 'converted',
        mode,
        convertedAt: Date.now(),
        imageAnalyzed:
          mode === 'text-images' && imageCount > 0 && imageAnalysisError === null
            ? true
            : undefined,
        visionProvider:
          mode === 'text-images' && imageCount > 0 ? vision.id : undefined,
        error:
          imageAnalysisError === null
            ? extraction.warning
            : `${imageAnalysisError}${extraction.warning === undefined ? '' : ` ${extraction.warning}`}`,
      }
      await writeState(projectRoot, state)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push({ path: document.path, error: reason })
      state[slug] = {
        path: document.path,
        status: 'failed',
        mode,
        error: reason,
      }
      await writeState(projectRoot, state)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  }

  await fs.rm(workRoot, { recursive: true, force: true })

  return {
    documents: (await scanDocuments(projectRoot)).documents,
    failed,
    cancelled,
  }
}