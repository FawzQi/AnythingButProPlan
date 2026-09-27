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
 * Two extractors, in order:
 *
 *   1. Marker (`marker_single --disable_ocr`). Best fidelity on academic
 *      PDFs: it reconstructs headings, tables, and figure references. Runs on
 *      CPU by design — see the note on `--disable_ocr` below.
 *   2. PyMuPDF4LLM, via a bundled Python script, when Marker is not on PATH.
 *      Faster and much lighter, but it does not understand two-column
 *      layouts, which is exactly what most papers are. The caller surfaces a
 *      warning when this path is used so the user knows why a two-column
 *      paper came out interleaved.
 *
 * Markdown and text files skip both: they are already text, and running a PDF
 * extractor over them would only add failure modes.
 *
 * Images come out of the extractors themselves — Marker writes an `images/`
 * directory beside the markdown, and the Python fallback is invoked with
 * `write_images`. Nothing re-extracts them separately, because a second
 * extraction would not line up with the markdown's figure references.
 */

/** Marker on a 40-page paper with two-column layout and tables. */
const MARKER_TIMEOUT_MS = 10 * 60_000
/** PyMuPDF4LLM is a pure text pass; anything near this means it hung. */
const PYTHON_TIMEOUT_MS = 3 * 60_000

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

interface Extraction {
  markdown: string
  /** Absolute path of the extractor's image directory, when it made one. */
  imagesDir: string | null
  /** Warning to surface to the user, e.g. the fallback's layout caveat. */
  warning?: string
  /** Which extractor produced the markdown, recorded for reproducibility. */
  extractor: 'marker' | 'fast' | 'passthrough'
}

/** Text files need no extraction; they are already markdown-ish. */
async function readPlainText(absolutePath: string): Promise<Extraction> {
  return {
    markdown: await fs.readFile(absolutePath, 'utf8'),
    imagesDir: null,
    extractor: 'passthrough',
  }
}

/**
 * Flags the installed Marker understands, probed once per process from
 * `marker_single --help`.
 *
 * Marker's CLI changes between releases — flags appear, get renamed, and get
 * removed — and an unrecognised flag makes click exit with code 2 before any
 * conversion runs, which would turn "this Marker is a version older than the
 * code" into "every PDF fails". Probing costs one cheap `--help` call and
 * turns the failure mode into a slower conversion instead of a broken one.
 */
let markerFlags: Set<string> | null = null

async function supportedMarkerFlags(): Promise<Set<string>> {
  if (markerFlags !== null) return markerFlags
  const help = await run('marker_single', ['--help'], 20_000)
  const flags = new Set<string>()
  for (const match of help.stdout.matchAll(/(--[a-z0-9-]+)/g)) {
    if (match[1] !== undefined) flags.add(match[1])
  }
  markerFlags = flags
  return flags
}

/**
 * An error the machine produced rather than the document.
 *
 * These are the failures where retrying through a lighter extractor is the
 * right answer: the PDF is fine, the box ran out of memory or its worker was
 * killed. A PDF-level failure (malformed file, unsupported encryption) is not
 * in this list and is reported to the user verbatim, because falling back
 * would hide the real reason the document failed.
 */
const RESOURCE_FAILURE = /force-killed|out of memory|oom|killed|memoryerror|cuda|worker .* died/i

async function extractWithMarker(
  absolutePath: string,
  workDir: string,
  wantImages: boolean,
): Promise<Extraction | { failed: string; resource: boolean }> {
  const flags = await supportedMarkerFlags()

  // Do NOT remove `--disable_ocr`. The flag is what keeps Marker on the CPU:
  // the target machine's GPU (GTX 1650 Max-Q, 4GB VRAM) cannot hold Marker's
  // models, and without the flag the process is OOM-killed mid-run, leaving a
  // half-written markdown file behind.
  const args = [absolutePath, '--output_dir', workDir, '--disable_ocr']

  // Text-only conversions do not need the figures, and skipping them saves
  // the image-extraction pass and the disk writes that go with it.
  if (!wantImages && flags.has('--disable_image_extraction')) {
    args.push('--disable_image_extraction')
  }
  // Marker renders every page at a low DPI for layout and a high DPI for
  // text/equation recognition. The defaults (96/192) are tuned for OCR of
  // photographed pages; these documents are born-digital PDFs with a text
  // layer, and lowering the high-resolution pass is the single biggest
  // speed-up available on CPU. The low-resolution pass stays at the default
  // because that is what the layout model reads.
  if (flags.has('--highres_image_dpi')) {
    args.push('--highres_image_dpi', '144')
  }
  if (flags.has('--output_format')) {
    args.push('--output_format', 'markdown')
  }

  let result = await run('marker_single', args, MARKER_TIMEOUT_MS)

  // Marker spawns a worker per model and its watchdog force-kills a worker
  // that stops answering — the "Force-killed fast_layout (pid …)" failure on
  // a machine without the RAM for two copies of the models. Retrying the same
  // document single-process costs another run but keeps only one set of
  // models resident, which is usually enough to finish. Worth the retry: the
  // alternative is seconds-per-page replaced by a weaker extractor on a
  // machine that could have produced the good output.
  if (
    result.code !== 0 &&
    !result.missing &&
    RESOURCE_FAILURE.test(result.stderr) &&
    flags.has('--disable_multiprocessing') &&
    !args.includes('--disable_multiprocessing')
  ) {
    result = await run(
      'marker_single',
      [...args, '--disable_multiprocessing'],
      MARKER_TIMEOUT_MS,
    )
  }

  if (result.missing) {
    return { failed: 'missing', resource: false }
  }
  if (result.timedOut) {
    return {
      failed: `Marker timed out after ${Math.round(MARKER_TIMEOUT_MS / 60_000)} minutes.`,
      resource: true,
    }
  }
  if (result.code !== 0) {
    return {
      failed: `Marker exited with code ${String(result.code)}: ${tail(result.stderr, 400)}`,
      resource: RESOURCE_FAILURE.test(result.stderr),
    }
  }

  const markdownPath = await findFirstWithExtension(workDir, '.md')
  if (markdownPath === null) {
    return {
      failed: `Marker produced no markdown. Its output was: ${tail(result.stdout, 200)}`,
      resource: false,
    }
  }
  const imagesCandidate = path.join(path.dirname(markdownPath), 'images')
  return {
    markdown: await fs.readFile(markdownPath, 'utf8'),
    imagesDir: (await exists(imagesCandidate)) ? imagesCandidate : null,
    extractor: 'marker',
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
 * The fast engine: pdftext (Marker's own CPU text extractor) with a
 * pypdfium2 fallback, both driven by `resources/python/pdf_to_markdown.py`.
 * Seconds per paper. No figures.
 */
async function extractFast(
  absolutePath: string,
  workDir: string,
): Promise<Extraction | { failed: string }> {
  const script = pythonScriptPath()
  if (!(await exists(script))) {
    return {
      failed: `Fast extractor script is missing at ${script}. Reinstall the app, or use the Marker engine.`,
    }
  }
  const result = await run(
    'python3',
    [script, absolutePath, workDir],
    PYTHON_TIMEOUT_MS,
  )
  if (result.missing) {
    return {
      failed:
        'python3 is not available. Install Python 3 (the extractor needs pdftext or pypdfium2 — both ship with Marker), or use the Marker engine.',
    }
  }
  if (result.timedOut) {
    return {
      failed: `The fast extractor timed out after ${Math.round(PYTHON_TIMEOUT_MS / 60_000)} minutes.`,
    }
  }
  if (result.code !== 0) {
    return {
      failed: `The fast extractor failed: ${tail(result.stderr, 300) || `exit code ${String(result.code)}`}`,
    }
  }
  const markdownPath = await findFirstWithExtension(workDir, '.md')
  if (markdownPath === null) {
    return { failed: 'The fast extractor produced no markdown.' }
  }
  // Which backend ran changes how a two-column paper reads, so it goes into
  // the warning the user sees rather than staying in the logs.
  const backend = /backend: pypdfium2/.test(result.stdout)
    ? 'pypdfium2 (no layout pass)'
    : 'pdftext'
  return {
    markdown: await fs.readFile(markdownPath, 'utf8'),
    imagesDir: null,
    extractor: 'fast',
    warning:
      `Converted with the fast extractor (${backend}) — no figures, and two-column papers may be interleaved. ` +
      'Use the Marker engine for figure descriptions or when reading order matters.',
  }
}

async function extract(
  absolutePath: string,
  relativePath: string,
  workDir: string,
  engine: ExtractionEngine,
  wantImages: boolean,
): Promise<Extraction | { failed: string }> {
  if (!PDF_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return readPlainText(absolutePath)
  }

  if (engine === 'fast') {
    return extractFast(absolutePath, workDir)
  }

  const viaMarker = await extractWithMarker(absolutePath, workDir, wantImages)
  if (!('failed' in viaMarker)) return viaMarker
  // Falling back is right when Marker is absent or when the *machine* failed
  // (its own watchdog force-killed the layout worker on a low-memory box).
  // A document-level failure — malformed file, encrypted PDF — is reported
  // instead, because retrying it through a weaker extractor would replace a
  // specific reason with a vague one.
  if (viaMarker.failed !== 'missing' && !viaMarker.resource) return viaMarker

  const fallback = await extractFast(absolutePath, workDir)
  if (!('failed' in fallback)) {
    return {
      ...fallback,
      warning:
        viaMarker.failed === 'missing'
          ? fallback.warning
          : `Marker could not finish this document on this machine (${viaMarker.failed.slice(0, 160)}). Converted with the fast extractor instead — no figures, and reading order may differ.`,
    }
  }
  return {
    failed: `${viaMarker.failed === 'missing' ? 'Marker is not installed.' : viaMarker.failed} The fallback also failed: ${fallback.failed}`,
  }
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
   * Which extractor to run. `auto` is Marker with a fallback; `fast` skips
   * Marker entirely. Marker reconstructs layout properly and costs minutes of
   * CPU per paper; PyMuPDF4LLM takes seconds and interleaves two-column
   * papers. Which one is right depends on the document, so the choice belongs
   * to the user rather than to a hardcoded order.
   */
  engine: ExtractionEngine
  /** Chat site the `webchat` engine drives. Unused by the other engines. */
  webChatTarget: WebChatTargetId
  visionProviderId?: DocumentEntry['visionProvider']
  onProgress: (progress: ConvertProgress) => void
}


/**
 * Convert every requested document. Sequential by design: Marker is
 * CPU-bound and saturates the machine on its own, so running two at once
 * makes both slower and doubles peak memory — which is the resource the
 * `--disable_ocr` flag exists to protect.
 */
export async function convertDocuments(
  options: ConvertOptions,
): Promise<ConvertResult> {
  const { projectRoot, mode, onProgress } = options
  // The chat engine is not an extractor at all: it needs a browser window,
  // the session the user is signed into, and minutes per document. It is
  // routed to its own module before any of the local machinery runs.
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

    // Figures need a layout model to know which image belongs to which
    // caption, and the fast engine has none. Refusing is the honest answer:
    // the alternative is a document recorded as `text-images` with no
    // descriptions in it, which the user only discovers when the prompt is
    // missing everything the figures said.
    if (engine === 'fast' && mode === 'text-images' && PDF_EXTENSIONS.has(path.extname(document.path).toLowerCase())) {
      const reason =
        'The fast extractor does not extract figures. Switch the extractor to Marker for a text + figures conversion, or convert in text-only mode.'
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
    const absoluteDoc = resolveWithinRoot(
      documentsRoot(projectRoot),
      document.path,
    )

    try {
      report('extracting', `Extracting text from ${path.basename(document.path)}`)
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.mkdir(workDir, { recursive: true })

      const extraction = await extract(
        absoluteDoc,
        document.path,
        workDir,
        engine,
        // Figures are only worth extracting when something will describe
        // them; in text mode Marker's image pass is pure cost.
        mode === 'text-images',
      )
      if ('failed' in extraction) {
        throw new Error(extraction.failed)
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
      await writeFileEnsuringDir(markdownPathFor(projectRoot, slug), markdown)

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
