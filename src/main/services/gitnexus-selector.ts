import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { countTokens } from 'gpt-tokenizer'
import type {
  AiProviderId,
  AiSuggestion,
  AiSuggestRequest,
} from '@shared/types'
import { buildCodebaseMap } from './codebase-map'
import { getProvider } from './ai-providers'
import { getApiKey, resolveModel } from './settings'
import { checkGitNexus, queryGitNexus, type GitNexusHit } from './gitnexus'
import {
  Bm25Index,
  tokenize,
  type SemanticHit,
} from './semantic-index'
import { resolveWithinRoot } from './fs-service'
import { parseSuggestedFiles } from './file-selector'
import { scoreCandidatesWithJev } from './jev'

/**
 * GitNexus-driven file suggestion.
 *
 * This is the second of the two pipelines the "Suggest files" button can
 * run; the other one (`suggestFiles` in `file-selector.ts`) sends a skeleton
 * of every file to the model in a single call. This one trades that single
 * call for a pipeline that keeps the expensive model call small even on
 * large repositories:
 *
 *   instruction
 *     ↓
 *   context ingestion   — recent `git log` (last 40 commits)
 *     ↓
 *   stage 1 (blind)     — the model expands the instruction into search
 *                         terms without seeing any code (~500 tokens)
 *     ↓
 *   hybrid search       — GitNexus graph query in parallel with a local
 *                         BM25 index over a shallow per-file preview
 *     ↓
 *   rerank              — merge, weight, boost recently-touched files, and
 *                         boost files that co-change with already-scored
 *                         candidates
 *     ↓
 *   stage 2             — build a skeleton of only the surviving
 *                         candidates (20–40 files) and ask the model to
 *                         rank them
 *
 * Nothing here is GitNexus-specific except the `queryGitNexus` call: when
 * the CLI is missing the hybrid search degrades to BM25 alone and the rest
 * of the pipeline still runs, with `gitnexusMissing` set on the result so
 * the UI can say so.
 */

const MAX_COMMITS = 40
const MAX_RECENT_FILES = 60
const CANDIDATE_LIMIT = 40
const SHALLOW_BYTES = 2048
const INDEX_CONCURRENCY = 32

const STAGE1_SYSTEM = `You expand a software-change instruction into search terms.

You will not see any code — only the instruction and a list of recently
changed file paths. Your job is to predict what an engineer would type into
a code search box to find the code involved.

Output ONLY a valid JSON object with exactly three keys, each an array of
strings. No prose, no markdown fences.

- "symbols": identifiers that likely appear in the code — function, class,
  type, and variable names. camelCase, snake_case, or PascalCase as they
  would appear in source.
- "concepts": short lowercase keywords describing the domain, feature, or
  behaviour, including synonyms the instruction does not use directly.
- "paths": plausible filename or directory fragments (e.g. "auth", "report",
  "api-client").

Include 5–15 entries per array. Never invent file paths you saw in the
recent-files list — those are context, not answers.`

const STAGE2_SYSTEM = `You rank files for a code change.

You will receive a small skeleton of candidate files (paths, exported
signatures, dependencies, and short previews) and a user instruction
describing a change. Pick the files that would actually need to change,
ordered most relevant first.

Output ONLY a valid JSON object with a single key "files": an array of
objects with exactly two keys:
- "path": the project-relative file path, exactly as shown.
- "purpose": a brief, one-sentence explanation of why this file needs to
  change.

Rules:
- Use the exact paths shown in the skeleton. Never invent a path.
- Include 3 to 15 files. Fewer is better when the change is small.
- Prefer files whose symbols or dependencies line up with the instruction
  over files that merely mention a keyword.
- Do not include files that would only be read for context.`

interface Stage1Signals {
  symbols: string[]
  concepts: string[]
  paths: string[]
}

interface CommitInfo {
  hash: string
  files: string[]
}

interface Candidate {
  path: string
  score: number
  reasons: string[]
}

/* ------------------------------------------------------------------ *
 * Git history
 * ------------------------------------------------------------------ */

function runGitLog(root: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['log', `-n${MAX_COMMITS}`, '--name-only', '--pretty=format:__C__%H'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    )
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => resolve(''))
    child.on('close', (code) => resolve(code === 0 ? stdout : ''))
  })
}

function parseGitLog(stdout: string): CommitInfo[] {
  const commits: CommitInfo[] = []
  let current: CommitInfo | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('__C__')) {
      current = { hash: line.slice(5), files: [] }
      commits.push(current)
      continue
    }
    if (current) current.files.push(line.replace(/\\/g, '/'))
  }
  return commits
}

async function readRecentGitHistory(root: string): Promise<CommitInfo[]> {
  const stdout = await runGitLog(root)
  return stdout === '' ? [] : parseGitLog(stdout)
}

/* ------------------------------------------------------------------ *
 * Shallow BM25 index
 * ------------------------------------------------------------------ */

async function readHead(
  root: string,
  relativePath: string,
  bytes: number,
): Promise<string> {
  const absolute = resolveWithinRoot(root, relativePath)
  const handle = await fs.open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Build a BM25 index over a shallow preview of every file: the path plus
 * the first couple of kilobytes. Deliberately not the whole file — the
 * point of this pipeline is to keep work off the model's context window,
 * and reading every file in full to score it defeats that on a large
 * repository. The preview is enough to catch imports, exports, and header
 * comments, which is where conceptual matches live.
 */
async function buildShallowIndex(
  root: string,
  filePaths: string[],
): Promise<Bm25Index> {
  const docs: { path: string; text: string }[] = []
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= filePaths.length) return
      const filePath = filePaths[index]
      if (filePath === undefined) continue
      try {
        const head = await readHead(root, filePath, SHALLOW_BYTES)
        docs.push({ path: filePath, text: `${filePath}\n${head}` })
      } catch {
        docs.push({ path: filePath, text: filePath })
      }
    }
  }

  const workers = Math.max(1, Math.min(INDEX_CONCURRENCY, filePaths.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return new Bm25Index(docs)
}

/* ------------------------------------------------------------------ *
 * Shared pipeline — used by both the LLM and no-LLM variants
 * ------------------------------------------------------------------ */

interface GitContext {
  history: CommitInfo[]
  recentFiles: string[]
}

/**
 * Read the last `MAX_COMMITS` commits and flatten them into a single
 * most-recent-first file list, capped at `MAX_RECENT_FILES`. Both variants
 * of the pipeline need this — the LLM variant feeds the recent list to
 * stage 1 as context, and both variants feed it to the reranker as the
 * "recent" boost signal.
 */
async function readGitContext(
  root: string,
  known: Set<string>,
): Promise<GitContext> {
  const history = await readRecentGitHistory(root)
  const recentFiles: string[] = []
  const seenRecent = new Set<string>()
  for (const commit of history) {
    for (const file of commit.files) {
      if (!known.has(file) || seenRecent.has(file)) continue
      seenRecent.add(file)
      recentFiles.push(file)
      if (recentFiles.length >= MAX_RECENT_FILES) break
    }
    if (recentFiles.length >= MAX_RECENT_FILES) break
  }
  return { history, recentFiles }
}

interface HybridSearchResult {
  gitnexusHits: GitNexusHit[]
  bm25Hits: SemanticHit[]
  gitnexusMissing: boolean
}

/**
 * Run the GitNexus graph query and the BM25 index in parallel. The graph
 * query is skipped when the CLI is not on PATH; BM25 always runs, so a
 * missing tool degrades to keyword-only search rather than an empty result.
 */
async function hybridSearch(
  root: string,
  filePaths: string[],
  terms: string[],
): Promise<HybridSearchResult> {
  const gitnexusStatus = await checkGitNexus()
  const [gitnexusHits, index] = await Promise.all([
    gitnexusStatus.available
      ? queryGitNexus(root, terms, 60)
      : Promise.resolve<GitNexusHit[]>([]),
    buildShallowIndex(root, filePaths),
  ])
  const bm25Hits = index.search(terms.join(' '), 60)
  return {
    gitnexusHits,
    bm25Hits,
    gitnexusMissing: !gitnexusStatus.available,
  }
}

/* ------------------------------------------------------------------ *
 * Stage 1 — blind keyword expansion
 * ------------------------------------------------------------------ */

async function expandInstruction(options: {
  providerId: AiProviderId
  apiKey: string
  model: string
  instruction: string
  recentFiles: string[]
}): Promise<{ signals: Stage1Signals; tokens: number }> {
  const provider = getProvider(options.providerId)
  const user = [
    'Instruction:',
    options.instruction.trim(),
    '',
    'Recently changed files (most recent first — context only, do not copy):',
    options.recentFiles.slice(0, 40).join('\n') || '(none)',
    '',
    'Return the JSON object now.',
  ].join('\n')

  const text = await provider.complete({
    apiKey: options.apiKey,
    model: options.model,
    system: STAGE1_SYSTEM,
    user,
    // Reasoning models scale this internally — a small base budget here is
    // deliberately aggressive for chat models, and the provider layer
    // multiplies it for anything with a thinking phase.
    maxTokens: 512,
    temperature: 0,
  })

  return { signals: parseStage1(text), tokens: countTokens(text) }
}

function parseStage1(text: string): Stage1Signals {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    return {
      symbols: toStringArray(parsed.symbols),
      concepts: toStringArray(parsed.concepts),
      paths: toStringArray(parsed.paths),
    }
  } catch {
    return { symbols: [], concepts: [], paths: [] }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .slice(0, 20)
}

/* ------------------------------------------------------------------ *
 * Rerank
 * ------------------------------------------------------------------ */

function aggregateCandidates(input: {
  gitnexusHits: GitNexusHit[]
  bm25Hits: SemanticHit[]
  history: CommitInfo[]
  recentFiles: string[]
  known: Set<string>
}): Candidate[] {
  const scores = new Map<string, number>()
  const reasons = new Map<string, string[]>()

  const bump = (path: string, amount: number, reason: string): void => {
    if (!input.known.has(path)) return
    scores.set(path, (scores.get(path) ?? 0) + amount)
    const list = reasons.get(path) ?? []
    if (!list.includes(reason)) list.push(reason)
    reasons.set(path, list)
  }

  // Rank-based rather than raw-score-based: GitNexus and BM25 scores are on
  // different scales and neither is calibrated, so the rank is the only
  // comparable signal. `1 / (rank + k)` with a small k flattens the head so
  // the top ten results are all worth something.
  input.gitnexusHits
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((hit, rank) => bump(hit.path, 3 / (rank + 5), 'gitnexus'))

  input.bm25Hits
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((hit, rank) => bump(hit.path, 2 / (rank + 5), 'semantic'))

  input.recentFiles.forEach((path, rank) => {
    bump(path, 1.5 / (rank + 5), 'recent')
  })

  // Co-change locality: a file that keeps appearing in the same commits as
  // another candidate is very likely part of the same change, even when
  // neither its name nor its contents match the query terms.
  const candidates = new Set(scores.keys())
  if (candidates.size > 0) {
    const coChange = new Map<string, number>()
    for (const commit of input.history) {
      const relevant = commit.files.filter((file) => candidates.has(file))
      if (relevant.length < 2) continue
      for (const file of relevant) {
        coChange.set(file, (coChange.get(file) ?? 0) + relevant.length - 1)
      }
    }
    for (const [path, count] of coChange) {
      bump(path, Math.min(count, 10) * 0.4, 'co-change')
    }
  }

  return [...scores.entries()]
    .map(([path, score]) => ({
      path,
      score,
      reasons: reasons.get(path) ?? [],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT)
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function suggestFilesGitNexus(
  request: AiSuggestRequest,
  providerId: AiProviderId,
): Promise<AiSuggestion> {
  const started = Date.now()
  const provider = getProvider(providerId)
  const apiKey = await getApiKey(providerId)
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${provider.label}. Add one in the Settings tab.`,
    )
  }
  const model = await resolveModel(providerId, provider.models[0] ?? '')
  const known = new Set(request.filePaths)

  // --- Context ingestion ------------------------------------------------
  const { history, recentFiles } = await readGitContext(
    request.projectRoot,
    known,
  )

  // --- Stage 1: blind keyword expansion --------------------------------
  const stage1 = await expandInstruction({
    providerId,
    apiKey,
    model,
    instruction: request.instruction,
    recentFiles,
  })
  const terms = [
    ...stage1.signals.symbols,
    ...stage1.signals.concepts,
    ...stage1.signals.paths,
  ]
  if (terms.length === 0) {
    // The model produced nothing usable; fall back to the raw instruction
    // so the local search at least has something to work with.
    terms.push(request.instruction)
  }

  // --- Hybrid search ---------------------------------------------------
  const { gitnexusHits, bm25Hits, gitnexusMissing } = await hybridSearch(
    request.projectRoot,
    request.filePaths,
    terms,
  )

  // --- Aggregate + rerank ---------------------------------------------
  const candidates = aggregateCandidates({
    gitnexusHits,
    bm25Hits,
    history,
    recentFiles,
    known,
  })

  if (candidates.length === 0) {
    return {
      paths: [],
      purposes: {},
      provider: providerId,
      model,
      mapTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      hallucinated: [],
      method: 'gitnexus',
      stage1Tokens: stage1.tokens,
      candidateCount: 0,
      gitnexusMissing,
    }
  }

  // --- Stage 2: targeted skeleton + LLM ranking ------------------------
  const candidatePaths = candidates.map((candidate) => candidate.path)
  const map = await buildCodebaseMap(request.projectRoot, candidatePaths)

  const user = [
    'Project skeleton (candidate files only):',
    '',
    map.text,
    '',
    '---',
    '',
    'Instruction:',
    request.instruction.trim(),
    '',
    'Return the ranked file list now.',
  ].join('\n')

  const text = await provider.complete({
    apiKey,
    model,
    system: STAGE2_SYSTEM,
    user,
    maxTokens: 1024,
    temperature: 0,
  })

  const { paths, purposes, hallucinated } = parseSuggestedFiles(text, known)

  return {
    paths,
    purposes,
    provider: providerId,
    model,
    mapTokens: countTokens(map.text),
    outputTokens: countTokens(text),
    durationMs: Date.now() - started,
    hallucinated,
    method: 'gitnexus',
    stage1Tokens: stage1.tokens,
    candidateCount: candidates.length,
    gitnexusMissing,
  }
}

/* ------------------------------------------------------------------ *
 * No-LLM variant — local search only
 * ------------------------------------------------------------------ */

/**
 * Same recall + rerank front half as `suggestFilesGitNexus`, but stops
 * before the LLM ranking call. The aggregated, git-history-reranked
 * candidate list IS the answer.
 *
 * The stage-1 blind expansion is replaced by a local tokenizer over the
 * instruction. That loses the model's vocabulary-bridging trick — a
 * request like "make login less sluggish" produces the tokens `make`,
 * `login`, `less`, `sluggish`, none of which appear in `session.ts` or
 * `auth.ts` — but it costs nothing, runs offline, and requires no API key.
 * The BM25 IDF term down-weights the common English words that survive
 * tokenization, and GitNexus's graph query supplies the structural half of
 * the recall without any model in the loop.
 *
 * The reasons collected during aggregation become the per-file "purpose"
 * so the UI shows *why* each file was picked rather than an empty string —
 * `gitnexus, recent`, `semantic, co-change`, and so on.
 */
export async function suggestFilesGitNexusOnly(
  request: AiSuggestRequest,
  providerId: AiProviderId,
): Promise<AiSuggestion> {
  const started = Date.now()
  const known = new Set(request.filePaths)

  // --- Context ingestion ------------------------------------------------
  const { history, recentFiles } = await readGitContext(
    request.projectRoot,
    known,
  )

  // --- Local keyword extraction ----------------------------------------
  // No model expands the instruction, so the tokens come straight from the
  // user's text. `tokenize` already splits camelCase and drops one-character
  // fragments; the raw instruction is kept as a fallback so a query that
  // tokenizes to nothing still has something to score against.
  const terms = tokenize(request.instruction)
  if (terms.length === 0) terms.push(request.instruction)

  // --- Hybrid search ---------------------------------------------------
  const { gitnexusHits, bm25Hits, gitnexusMissing } = await hybridSearch(
    request.projectRoot,
    request.filePaths,
    terms,
  )

  // --- Aggregate + rerank ---------------------------------------------
  const candidates = aggregateCandidates({
    gitnexusHits,
    bm25Hits,
    history,
    recentFiles,
    known,
  })

  const purposes: Record<string, string> = {}
  for (const candidate of candidates) {
    purposes[candidate.path] =
      candidate.reasons.length > 0
        ? `matched via ${candidate.reasons.join(', ')}`
        : 'candidate'
  }

  return {
    paths: candidates.map((candidate) => candidate.path),
    purposes,
    provider: providerId,
    // `model` is a display string on the result; nothing was called, so
    // say so rather than reporting the user's configured model name.
    model: 'local search',
    // Nothing was sent to a model, so the token counts are honestly zero.
    // `mapTokens: 0` also means the "this map is huge" warning stays
    // silent for this method, which is correct — the whole point of the
    // no-LLM path is that the map never leaves the machine.
    mapTokens: 0,
    outputTokens: 0,
    durationMs: Date.now() - started,
    hallucinated: [],
    method: 'gitnexus-only',
    stage1Tokens: 0,
    candidateCount: candidates.length,
    gitnexusMissing,
  }
}

/* ------------------------------------------------------------------ *
 * Jev variant — local recall, Jev precision
 * ------------------------------------------------------------------ */

/**
 * Score at or above which a Jev answer is treated as "include". Anything
 * at 2 is flagged for human review; anything at 0–1 is dropped. The
 * thresholds live here rather than in the routing loop so the two numbers
 * are visible together and can be tuned in one place once the user has
 * validated them against their own repository's history.
 */
const JEV_INCLUDE_SCORE = 3
const JEV_REVIEW_SCORE = 2
/**
 * Confidence floor for automatic inclusion. Jev's confidences are
 * calibrated, so a 0.85 really does mean roughly 85% likely correct. A
 * score-3 answer below this floor lands in the review bucket instead of
 * the include bucket — the score says "relevant", the confidence says
 * "verify before trusting".
 */
const JEV_HIGH_CONFIDENCE = 0.85

/**
 * Same recall front half as `suggestFilesGitNexusOnly` — instruction
 * tokenized locally, GitNexus + BM25 hybrid search, git-history rerank —
 * but the surviving candidates are handed to Jev for a per-file relevance
 * judgment instead of being returned as-is.
 *
 * The three-way routing rule maps Jev's calibrated output onto the UI:
 *
 *   score 3 + confidence ≥ 0.85  → included (pre-selected in the tree)
 *   score 2, or score 3 low-conf  → flagged for review
 *   score 0–1                    → dropped, counted but not shown
 *
 * No chat provider is contacted. The only outbound call is to TypeSafe,
 * and its cost is bounded by the candidate set size — Jev bills input
 * tokens, and the batch size keeps the round-trip count low.
 */
export async function suggestFilesGitNexusJev(
  request: AiSuggestRequest,
): Promise<AiSuggestion> {
  const started = Date.now()
  const known = new Set(request.filePaths)

  // --- Context ingestion ------------------------------------------------
  const { history, recentFiles } = await readGitContext(
    request.projectRoot,
    known,
  )

  // --- Local keyword extraction ----------------------------------------
  const terms = tokenize(request.instruction)
  if (terms.length === 0) terms.push(request.instruction)

  // --- Hybrid recall ---------------------------------------------------
  const { gitnexusHits, bm25Hits, gitnexusMissing } = await hybridSearch(
    request.projectRoot,
    request.filePaths,
    terms,
  )

  const candidates = aggregateCandidates({
    gitnexusHits,
    bm25Hits,
    history,
    recentFiles,
    known,
  })

  if (candidates.length === 0) {
    return {
      paths: [],
      purposes: {},
      provider: 'typesafe',
      model: '',
      mapTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      hallucinated: [],
      method: 'gitnexus-jev',
      candidateCount: 0,
      gitnexusMissing,
      jevScores: {},
      jevConfidence: {},
      jevIncluded: [],
      jevFlagged: [],
      jevDropped: [],
      jevBatchCount: 0,
      jevTokens: 0,
    }
  }

  // --- Skeleton for the surviving candidates ---------------------------
  const candidatePaths = candidates.map((candidate) => candidate.path)
  const map = await buildCodebaseMap(request.projectRoot, candidatePaths)
  const skeletonByPath = splitSkeletonMap(map.text)

  // --- Jev precision ---------------------------------------------------
  const apiKey = await getApiKey('typesafe')
  if (!apiKey) {
    throw new Error(
      'No TypeSafe API key saved. Add one in the Settings tab to use the ' +
        '"GitNexus + Jev" suggestion method.',
    )
  }
  const model = await resolveModel('typesafe', 'jev-latest')

  const jev = await scoreCandidatesWithJev({
    apiKey,
    model,
    instruction: request.instruction,
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      skeleton: skeletonByPath.get(candidate.path) ?? candidate.path,
    })),
  })

  // --- Routing ---------------------------------------------------------
  const scoresByPath: Record<string, number> = {}
  const confidenceByPath: Record<string, number> = {}
  const reasonsByPath = new Map(
    candidates.map((candidate) => [candidate.path, candidate.reasons]),
  )
  const included: string[] = []
  const flagged: string[] = []
  const dropped: string[] = []
  const purposes: Record<string, string> = {}

  const formatReason = (path: string): string => {
    const reasons = reasonsByPath.get(path) ?? []
    return reasons.length > 0 ? ` — ${reasons.join(', ')}` : ''
  }

  for (const result of jev.results) {
    scoresByPath[result.path] = result.score
    confidenceByPath[result.path] = result.confidence
    const confidencePct = Math.round(result.confidence * 100)

    const isInclude =
      result.score >= JEV_INCLUDE_SCORE &&
      result.confidence >= JEV_HIGH_CONFIDENCE

    if (isInclude) {
      included.push(result.path)
      purposes[result.path] =
        `Jev ${result.score}/3, ${confidencePct}% confident` +
        formatReason(result.path)
      continue
    }

    if (result.score >= JEV_REVIEW_SCORE) {
      flagged.push(result.path)
      purposes[result.path] =
        `Jev ${result.score}/3, ${confidencePct}% confident — review` +
        formatReason(result.path)
      continue
    }

    dropped.push(result.path)
  }

  // Included files come first because that is the order the tree selection
  // applies them in; flagged files follow so the user can eyeball them
  // without hunting through the list.
  const orderedPaths = [...included, ...flagged]

  return {
    paths: orderedPaths,
    purposes,
    provider: 'typesafe',
    model,
    mapTokens: countTokens(map.text),
    outputTokens: 0,
    durationMs: Date.now() - started,
    hallucinated: [],
    method: 'gitnexus-jev',
    candidateCount: candidates.length,
    gitnexusMissing,
    jevScores: scoresByPath,
    jevConfidence: confidenceByPath,
    jevIncluded: included,
    jevFlagged: flagged,
    jevDropped: dropped,
    jevBatchCount: jev.batches,
    jevTokens: jev.tokens,
  }
}

/**
 * Recover per-file sections from the joined map that `buildCodebaseMap`
 * produces. Entries are separated by a blank line and start with the path
 * followed by two or more spaces and a bracketed header — see
 * `formatSkeleton` in `codebase-map.ts`. The regex is deliberately loose
 * about the exact header contents so a change to `formatSkeleton` does not
 * silently break the split; the invariant this depends on is only "path,
 * then whitespace, then a bracket".
 */
function splitSkeletonMap(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  for (const section of text.split('\n\n')) {
    const firstLine = section.split('\n')[0] ?? ''
    const match = /^(.+?)\s{2,}\[/.exec(firstLine)
    if (match?.[1]) sections.set(match[1], section)
  }
  return sections
}