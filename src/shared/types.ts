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

/**
 * One entry in the saved-folder list. Saved folders appear in the "Recent"
 * dropdown next to every Open folder button so the user can jump back into
 * a project without going through the native picker.
 *
 * Entries are added automatically when a folder is opened — from the picker
 * or from the recent menu — and pruned automatically when the path on disk
 * no longer exists. The list is capped at a small number (see
 * `recent-folders.ts`) so it stays a shortcut rather than a browsing UI.
 */
export interface RecentFolder {
  /** Absolute path to the folder, as the native picker returned it. */
  path: string
  /** Display label. Defaults to the folder's basename. */
  label: string
  /** Unix milliseconds of the last time this folder was opened. */
  lastOpenedAt: number
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

/**
 * Fields shared by every parsed-file variant. `content` is the full file
 * body for `kind: 'full'` and `kind: 'unresolved'`, and the rendered
 * SEARCH/REPLACE text (for display only) for `kind: 'patch'`. It is the
 * empty string for `kind: 'delete'`.
 */
interface ParsedFileCommon {
  /** Original text the AI wrote for this entry. Kept for the diff view. */
  rawBlock: string
  language: string | null
  pathSource: PathSource
  content: string
}

/**
 * One entry from the AI response, discriminated on how it should be applied.
 *
 *   - `full`       — a whole file the model emitted, with a target path.
 *   - `unresolved` — a whole file with no usable path; the user must supply
 *                    one before it can be applied.
 *   - `patch`      — SEARCH/REPLACE pairs to apply against the file on disk.
 *   - `delete`     — a `Delete: <path>` directive: remove the file.
 *
 * The tag replaces the previous `path: string | null`, `ambiguous: boolean`,
 * `patches?: PatchBlock[]`, and `delete?: boolean` fields, which together
 * admitted contradictory states (a delete with patches, an ambiguous entry
 * with a path) that the parser maintained only by convention.
 */
export type ParsedFile =
  | (ParsedFileCommon & { kind: 'full'; path: string })
  | (ParsedFileCommon & { kind: 'unresolved'; path: null })
  | (ParsedFileCommon & { kind: 'patch'; path: string; patches: PatchBlock[] })
  | (ParsedFileCommon & {
      kind: 'delete'
      path: string
      pathSource: 'delete-header'
    })

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
   * When true, the applier deletes `path` instead of writing any content.
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

/**
 * Input for the native confirmation dialog. Replaces `window.confirm` in the
 * renderer. Electron's synchronous `window.confirm` blocks the renderer
 * process while the dialog is open and — on some platforms — leaves keyboard
 * focus in a broken state after the dialog closes: clicking into a textarea
 * afterwards moves the caret but no key events reach the input, so the user
 * "can't type". Routing the prompt through the main process keeps the
 * renderer's focus state intact.
 */
export interface ConfirmDialogRequest {
  /** Primary question, rendered as the dialog's bold headline. */
  message: string
  /** Optional secondary paragraph for consequences or extra context. */
  detail?: string
  /** Label on the affirmative button. Defaults to "OK". */
  confirmLabel?: string
  /** Label on the negative button. Defaults to "Cancel". */
  cancelLabel?: string
  /**
   * Visual severity, which selects the dialog's icon. `danger` maps to
   * Electron's `warning` icon — the tone exists so callers can express
   * intent without the mapping leaking into every call site.
   */
  tone?: 'info' | 'question' | 'warning' | 'danger'
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

/* ------------------------------------------------------------------------ *
 * AI file selection
 * ------------------------------------------------------------------------ */

export type AiProviderId =
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'google'
  /**
   * TypeSafe hosts the Jev typed-decision model. It is not a chat provider —
   * `complete()` on the provider entry throws — but registering it here
   * gives the Jev API key the same encrypted-at-rest storage that the chat
   * providers get, and puts the Jev model names in the settings picker.
   */
  | 'typesafe'

/**
 * Which pipeline the "Suggest files" button runs.
 *
 *   - `gitnexus-only` — local recall only: GitNexus graph queries, BM25
 *                       fallback, git-history reranking. The ranked
 *                       candidate list IS the answer. No model call, no
 *                       API key required, zero token cost. Useful offline,
 *                       on a metered connection, or on a project where
 *                       the user wants predictable behaviour.
 *   - `gitnexus-jev`  — same recall front half as `gitnexus-only`, but the
 *                       precision pass uses Jev (a typed-decision model).
 *                       Each candidate gets one `Score` question asking
 *                       how relevant it is; the returned scores and
 *                       calibrated confidences are routed into include /
 *                       flag-for-review / drop. Requires a TypeSafe API
 *                       key; no chat provider is contacted.
 *   - `gitnexus-llm`  — same recall front half as `gitnexus-only`, but the
 *                       precision pass uses an ordinary chat completion
 *                       (DeepSeek, Groq, OpenRouter, or Google AI Studio).
 *                       The surviving candidates are handed to the model
 *                       in one prompt and it returns a JSON verdict per
 *                       file, scored on the same 0–3 scale Jev uses. Use
 *                       this when the TypeSafe key is not available but a
 *                       chat provider key already is, or when the user
 *                       wants to compare how a general model ranks the
 *                       candidates against Jev's calibrated answers.
 */
export type SuggestMethod = 'gitnexus-only' | 'gitnexus-jev' | 'gitnexus-llm'

/**
 * Which half of the app is on screen.
 *
 *   - `coding`   — source tree in, patch out: FileTree, PromptDashboard,
 *                  ResponsePanel, apply engine, Git integration.
 *   - `research` — document set in, cited answer out: DocumentTree,
 *                  ResearchDashboard, ResponsePanel.
 *
 * The mode is a whole-app switch rather than a per-project one, and it is
 * persisted, because it tracks what the user is doing rather than what the
 * folder contains — the same folder of PDFs is still research mode after a
 * restart.
 */
export type AppMode = 'coding' | 'research'

export interface AiProviderInfo {
  id: AiProviderId
  /** Human-readable name for the settings UI. */
  label: string
  /** Where the user gets an API key. Shown as a link. */
  keyUrl: string
  /** Models the provider exposes. First entry is the default. */
  models: string[]
}

/**
 * Persisted AI configuration. The API keys themselves never cross the
 * contextBridge — the renderer only learns whether a key is present, so a
 * compromised renderer cannot exfiltrate them. Every call that needs a key
 * goes through the main process.
 */
export interface AiSettings {
  provider: AiProviderId | null
  /** Chosen model per provider. Missing entry means "use the provider default". */
  modelByProvider: Partial<Record<AiProviderId, string>>
  /** True when a key has been saved for this provider. */
  hasApiKey: Partial<Record<AiProviderId, boolean>>
  /**
   * Which file-suggestion pipeline the "Suggest files" button runs.
   */
  suggestMethod: SuggestMethod
  /**
   * Which web chat site the "Send to web chat" button targets. The site is
   * driven through its own web UI in a dedicated window — no API key, no
   * per-token billing.
   */
  webChatTarget: WebChatTargetId
  /** Coding mode or research mode — see `AppMode`. */
  mode: AppMode
}

export interface AiSettingsSaveRequest {
  provider?: AiProviderId | null
  /** Set or replace the model for one provider. */
  model?: { provider: AiProviderId; model: string }
  /** Set or replace the API key for one provider. Empty string clears it. */
  apiKey?: { provider: AiProviderId; key: string }
  /** Switch the file-suggestion pipeline. */
  suggestMethod?: SuggestMethod
  /** Switch the web chat target used by "Send to web chat". */
  webChatTarget?: WebChatTargetId
  /** Switch between coding mode and research mode. */
  mode?: AppMode
}

export interface AiSuggestRequest {
  projectRoot: string
  /** Every file path in the scanned tree — the AI may only pick from these. */
  filePaths: string[]
  /** The user's "Additional instructions" text — the feature request. */
  instruction: string
  /** When true, bypasses the LLM and only computes the codebase map tokens. */
  dryRun?: boolean
}

export interface AiSuggestion {
  /** Validated paths the AI picked, in the order it returned them. */
  paths: string[]
  /** Brief explanation of why each file was selected, keyed by path. */
  purposes: Record<string, string>
  provider: AiProviderId
  model: string
  /** Approximate tokens in the skeleton map that was sent. */
  mapTokens: number
  /** Approximate tokens in the AI response. */
  outputTokens: number
  /** Wall-clock duration of the API call, milliseconds. */
  durationMs: number
  /**
   * Paths the AI returned that do not exist in the scanned tree. Surfaced so
   * the UI can warn the user that the model hallucinated; never applied.
   */
  hallucinated: string[]
  /** Which pipeline produced this suggestion. */
  method?: SuggestMethod
  /**
   * Tokens consumed by the stage-1 keyword expansion call. Only present for
   * the `gitnexus` method, which is the only one with a stage 1.
   */
  stage1Tokens?: number
  /**
   * How many candidates survived hybrid search + reranking and were handed
   * to the stage-2 ranking call. Only present for the `gitnexus` method.
   */
  candidateCount?: number
  /**
   * True when the GitNexus method was selected but the `gitnexus` CLI was
   * not found on PATH. The pipeline degrades to BM25-only search in that
   * case; the flag lets the UI say so instead of silently producing weaker
   * results.
   */
  gitnexusMissing?: boolean

  /**
   * Per-file Jev relevance score (0–3) keyed by path. Only present for the
   * `gitnexus-jev` method.
   */
  jevScores?: Record<string, number>
  /**
   * Per-file Jev confidence (0–1) keyed by path. Present for the
   * `gitnexus-jev` method. This is the calibrated probability Jev reports
   * for its own answer, and it is what the routing thresholds read.
   */
  jevConfidence?: Record<string, number>
  /**
   * Paths Jev scored 3 with high confidence. These are the entries the user
   * sees pre-selected in the tree.
   */
  jevIncluded?: string[]
  /**
   * Paths Jev scored 2. Surfaced for human review rather than selected by
   * default — the "flag for review" tier of the routing rule.
   */
  jevFlagged?: string[]
  /**
   * Paths Jev scored 0 or 1. Dropped from the suggestion entirely; kept in
   * the result so the UI can report how many were filtered out.
   */
  jevDropped?: string[]
  /** Number of Jev API calls made. Only present for `gitnexus-jev`. */
  jevBatchCount?: number
  /** Input tokens billed by Jev. Only present for `gitnexus-jev`. */
  jevTokens?: number
}

/* ------------------------------------------------------------------------ *
 * Web chat bridge
 * ------------------------------------------------------------------------ */

/**
 * Which chat site "Send to web chat" drives. Each target is a full web UI
 * opened in its own Electron window: the app types the prompt into the
 * site's composer, submits it, waits for the reply to finish streaming, and
 * scrapes the assistant's text back into the AI Response panel.
 *
 * This path exists so the app can be used without an API key. The trade-off
 * is that it depends on each site's DOM, which changes without notice.
 */
export type WebChatTargetId =
  | 'deepseek'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'kimi'
  | 'qwen'

/** Display metadata for the web chat target picker in Settings. */
export interface WebChatTargetInfo {
  id: WebChatTargetId
  label: string
  /** The site's landing URL, shown as a hint in Settings. */
  url: string
}

export interface WebChatSendRequest {
  target: WebChatTargetId
  prompt: string
}

export interface WebChatSendResult {
  ok: boolean
  /** The scraped assistant text. Present when `ok` is true. */
  text?: string
  /** User-readable failure reason. Present when `ok` is false. */
  error?: string
}

/**
 * Live state of a web chat site's window, as observed by the main process
 * while a send is in flight.
 *
 *   - `idle`    — no send is in flight. The window is open or hidden, but
 *                 nothing is happening.
 *   - `working` — the site is streaming a reply. A visible "Stop" control
 *                 or a changing message body was observed.
 *   - `paused`  — generation stopped mid-reply and the site is waiting on
 *                 the user to press a "Continue" button before it will
 *                 finish. DeepSeek does this after a long reasoning phase
 *                 on some models. Not the same as `idle`; the reply is
 *                 incomplete and only a click in the window can resume it.
 */
export type WebChatStatus = 'idle' | 'working' | 'paused'

/* ------------------------------------------------------------------------ *
 * Research mode
 * ------------------------------------------------------------------------ */

/**
 * How a document is converted.
 *
 *   - `text`        — text only. Figures are left as whatever the converter
 *                     emits (Marker writes image files next to the markdown
 *                     and references them); no vision call is made.
 *   - `text-images` — text plus a vision pass over the extracted figures,
 *                     each described by a chat model and the description
 *                     appended to the markdown under the figure reference.
 *                     Costs a provider call; a paper with 30 figures is a
 *                     few cents on DeepSeek.
 */
export type ConversionMode = 'text' | 'text-images'

/**
 * Where a document sits in the conversion pipeline.
 *
 *   - `ready`      — found under `docs/`, no conversion recorded yet.
 *   - `converted`  — markdown exists under `converted/<slug>/`. Image
 *                    analysis may or may not have run; `imageAnalyzed` says.
 *   - `failed`     — the last attempt failed. `error` holds the reason. The
 *                    record survives so the failure is visible on the next
 *                    launch instead of the document silently reverting to
 *                    `ready`.
 */
export type DocumentStatus = 'ready' | 'converted' | 'failed'

export interface DocumentEntry {
  /** Path relative to `docs/`, POSIX separators. */
  path: string
  /** Flat directory name under `converted/` for this document. */
  slug: string
  sizeBytes: number
  status: DocumentStatus
  /** Present once a conversion has run. */
  mode?: ConversionMode
  convertedAt?: number
  /**
   * True when the vision pass completed for this document. This flag — not a
   * UI checkbox — is what stops a second analysis run: the recorded provider
   * and descriptions are already in `meta.json`.
   */
  imageAnalyzed?: boolean
  /** Provider used for the vision pass, recorded so re-runs stay consistent. */
  visionProvider?: AiProviderId
  /** Chunks this document contributed to the last index build. */
  chunkCount?: number
  /** Failure reason from the last attempt. Present when status is `failed`. */
  error?: string
  /** True when the converted markdown is on disk (regardless of staleness). */
  convertedExists: boolean
}

/** State of the retrieval index, read from `.index/meta.json`. */
export interface IndexStatus {
  built: boolean
  documentCount: number
  chunkCount: number
  dimensions: number
  /** Embedding model the vectors were produced with. */
  model: string | null
  builtAt: number | null
}

export interface ResearchScanResult {
  /** True when `<project_root>/docs` exists. */
  docsDirExists: boolean
  /**
   * Where the documents were read from. `docs` is the intended layout; `root`
   * is the fallback used when there is no `docs/` folder, so that opening a
   * folder full of PDFs does not report an empty project.
   */
  sourceDir: 'docs' | 'root'
  documents: DocumentEntry[]
  index: IndexStatus
}

/**
 * Which extractor converts a PDF.
 *
 *   - `auto`    — Marker, falling back to the fast extractor when Marker is
 *                 missing or when the machine kills its worker. Best layout
 *                 fidelity, and the slowest option on CPU: a 40-page paper is
 *                 minutes.
 *   - `fast`    — pdftext/pypdfium2. Seconds per paper, no layout model, so
 *                 two-column papers come out interleaved and figures are left
 *                 out entirely.
 *   - `webchat` — extract raw text now, then hand it to a chat model to
 *                 rewrite as markdown: figures described from their captions,
 *                 chart and table data rebuilt as markdown tables. Runs
 *                 through the same web-chat bridge as "Send to web chat", so
 *                 it needs no API key — and because the rewrite is a chat
 *                 turn, its result comes back through the AI Response panel
 *                 and is written from there (see `ResearchPromptMode`
 *                 `rewrite`).
 */
export type ExtractionEngine = 'auto' | 'fast' | 'webchat'

export interface ConvertRequest {
  projectRoot: string
  /** `docs/`-relative paths to convert. Empty means "every document". */
  docPaths: string[]
  mode: ConversionMode
  /** Extractor to run. Defaults to `auto`. */
  engine?: ExtractionEngine
  /** Vision provider for `text-images`. Ignored for `text`. */
  visionProvider?: AiProviderId
}

/** One progress tick per stage per document. */
export interface ConvertProgress {
  path: string
  /** 1-based position of this document in the batch. */
  index: number
  total: number
  /**
   * `chatting` is the `webchat` engine's long step: the document is attached
   * to a chat site and the reply is awaited, which takes as long as the model
   * takes.
   */
  stage: 'extracting' | 'images' | 'saving' | 'chatting'
  message: string
}

export interface ConvertResult {
  documents: DocumentEntry[]
  /**
   * Documents that failed, with the reason. A failed document is reported
   * here and recorded in the state file — it is never dropped from the list.
   */
  failed: { path: string; error: string }[]
  /** True when the user cancelled before the batch finished. */
  cancelled: boolean
}

export interface IndexBuildRequest {
  projectRoot: string
  /** Documents to index. Empty means "every converted document". */
  docPaths: string[]
}

export interface IndexBuildProgress {
  stage: 'chunking' | 'embedding' | 'saving'
  done: number
  total: number
  message: string
}

export interface IndexBuildResult {
  index: IndexStatus
  /** Documents skipped because they have no converted markdown yet. */
  skipped: string[]
}

/**
 * Which research prompt to build.
 *
 *   - `full` — every converted document inlined. Simple, expensive, and the
 *              right answer for a handful of short papers.
 *   - `rag`  — question-driven retrieval: the question, one abstract per
 *              source document, then the top-ranked excerpts with a citation
 *              header on each.
 */
export type ResearchPromptMode = 'full' | 'rag'

export interface ResearchPromptRequest {
  projectRoot: string
  mode: ResearchPromptMode
  /** Documents to include. Empty means "every converted document". */
  docPaths: string[]
  /** Required for `rag`. */
  question?: string
  /** Excerpts kept after retrieval. Defaults to 8. */
  topK?: number
  /**
   * Ask the chat provider to re-rank the retrieved candidates. Costs one
   * extra call and helps when the embedding model returns near-ties.
   */
  rerank?: boolean
}

export interface ResearchCitation {
  document: string
  heading: string
}

export interface ResearchPromptResult {
  prompt: string
  tokenCount: number
  documentCount: number
  /** Excerpts included. Zero for `full`. */
  chunkCount: number
  /** Titles of the documents that went in, in prompt order. */
  documents: string[]
  citations: ResearchCitation[]
  /** Documents that could not be read; reported, never silently dropped. */
  unreadable: string[]
}

export interface ResearchCancelRequest {
  projectRoot: string
}