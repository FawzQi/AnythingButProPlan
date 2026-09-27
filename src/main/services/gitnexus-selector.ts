import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { countTokens } from 'gpt-tokenizer'
import type {
  AiProviderId,
  AiSuggestion,
  AiSuggestRequest,
} from '@shared/types'
import { buildCodebaseMap } from './codebase-map'
import { getApiKey, resolveModel } from './settings'
import { checkGitNexus, queryGitNexus, type GitNexusHit } from './gitnexus'
import {
  Bm25Index,
  tokenize,
  type SemanticHit,
} from './semantic-index'
import { resolveWithinRoot } from './fs-service'
import { scoreCandidatesWithJev } from './jev'
import { rankCandidatesWithLlm } from './llm-ranker'

/**
 * GitNexus-driven file suggestion.
 *
 * Three pipelines share the same recall front half — GitNexus graph queries
 * and a local BM25 index over a shallow per-file preview, merged and
 * reranked by git recency and co-change locality. They differ only in how
 * the surviving candidates become the final answer:
 *
 *   `gitnexus-only` — the ranked candidate list IS the answer. No model
 *                     call, no API key, zero token cost.
 *   `gitnexus-jev`  — each candidate is scored by Jev, a typed-decision
 *                     model, on a 0–3 relevance scale. The calibrated
 *                     scores and confidences are routed into include /
 *                     flag-for-review / drop.
 *   `gitnexus-llm`  — each candidate is rated by an ordinary chat model
 *                     (DeepSeek, Groq, OpenRouter, Google AI Studio) on the
 *                     same 0–3 scale. The ratings and the model's
 *                     self-reported confidence are routed identically. This
 *                     exists so the precision pass is available to users
 *                     with a chat-provider key but no TypeSafe key, and so
 *                     a general model's ranking can be compared against
 *                     Jev's on the same project.
 *
 * The recall half is entirely local. `queryGitNexus` shells out to the
 * user-installed `gitnexus` CLI; when that tool is missing the hybrid
 * search degrades to BM25 alone and the rest of the pipeline still runs,
 * with `gitnexusMissing` set on the result so the UI can say so.
 */

const MAX_COMMITS = 40
const MAX_RECENT_FILES = 60
const CANDIDATE_LIMIT = 40
const SHALLOW_BYTES = 2048
const INDEX_CONCURRENCY = 32

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
 * Shared pipeline — used by all variants
 * ------------------------------------------------------------------ */

interface GitContext {
  history: CommitInfo[]
  recentFiles: string[]
}

/**
 * Read the last `MAX_COMMITS` commits and flatten them into a single
 * most-recent-first file list, capped at `MAX_RECENT_FILES`. Every variant
 * of the pipeline feeds this list to the reranker as the "recent" boost
 * signal.
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
 * No-LLM variant — local search only
 * ------------------------------------------------------------------ */

/**
 * Local recall: instruction tokenized locally, GitNexus + BM25 hybrid
 * search, git-history rerank. The aggregated, reranked candidate list IS
 * the answer.
 *
 * Because no model expands the instruction, the tokens come straight from
 * the user's text. That loses the vocabulary-bridging that an LLM
 * expansion provides — a request like "make login less sluggish" produces
 * the tokens `make`, `login`, `less`, `sluggish`, none of which appear in
 * `session.ts` or `auth.ts` — but it costs nothing, runs offline, and
 * requires no API key. The BM25 IDF term down-weights the common English
 * words that survive tokenization, and GitNexus's graph query supplies
 * the structural half of the recall without any model in the loop.
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
 * Same recall front half as `suggestFilesGitNexusOnly`, but the surviving
 * candidates are handed to Jev for a per-file relevance judgment instead
 * of being returned as-is.
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

/* ------------------------------------------------------------------ *
 * LLM variant — local recall, chat-model precision
 * ------------------------------------------------------------------ */

/**
 * Same recall front half as the other two variants, but the surviving
 * candidates are rated by an ordinary chat completion instead of Jev. The
 * rubric is the same 0–3 scale, and the same threshold table routes the
 * ratings into include / flag / drop.
 *
 * The difference from the Jev path is the confidence source. Jev returns a
 * calibrated probability; a chat model returns a self-reported number that
 * is best treated as a rough signal. The confidence floor is therefore
 * applied the same way but the UI labels the results as coming from the
 * chat provider, so a user comparing the two methods can see which one
 * produced a given verdict.
 *
 * Errors are surfaced rather than swallowed: a missing key, an
 * authentication failure, or a provider that refuses the request all need
 * to reach the user with enough context to fix them, and the only way to
 * do that is to let the error propagate up to the IPC handler.
 */
export async function suggestFilesGitNexusLlm(
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
      provider: providerId,
      model: '',
      mapTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      hallucinated: [],
      method: 'gitnexus-llm',
      candidateCount: 0,
      gitnexusMissing,
      jevScores: {},
      jevConfidence: {},
      jevIncluded: [],
      jevFlagged: [],
      jevDropped: [],
    }
  }

  // --- Skeleton for the surviving candidates ---------------------------
  const candidatePaths = candidates.map((candidate) => candidate.path)
  const map = await buildCodebaseMap(request.projectRoot, candidatePaths)
  const skeletonByPath = splitSkeletonMap(map.text)

  // --- Chat-model precision --------------------------------------------
  const apiKey = await getApiKey(providerId)
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${providerId}. Add one in the Settings tab to ` +
        `use the "GitNexus + LLM" suggestion method.`,
    )
  }
  const model = await resolveModel(
    providerId,
    getDefaultModel(providerId),
  )

  const ranked = await rankCandidatesWithLlm({
    apiKey,
    provider: providerId,
    model,
    instruction: request.instruction,
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      skeleton: skeletonByPath.get(candidate.path) ?? candidate.path,
    })),
  })

  // --- Routing ---------------------------------------------------------
  // The routing rule is shared with the Jev path — same thresholds, same
  // three buckets — because the LLM is asked for the same 0–3 rating on
  // the same rubric. The only difference the UI needs to know about is
  // that the confidence came from the model itself, which it can infer
  // from `method === 'gitnexus-llm'`.
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

  for (const verdict of ranked.verdicts) {
    scoresByPath[verdict.path] = verdict.score
    confidenceByPath[verdict.path] = verdict.confidence
    const confidencePct = Math.round(verdict.confidence * 100)
    const llmNote =
      verdict.reason !== undefined ? `, "${verdict.reason}"` : ''

    const isInclude =
      verdict.score >= JEV_INCLUDE_SCORE &&
      verdict.confidence >= JEV_HIGH_CONFIDENCE

    if (isInclude) {
      included.push(verdict.path)
      purposes[verdict.path] =
        `LLM ${verdict.score}/3, ${confidencePct}% confident${llmNote}` +
        formatReason(verdict.path)
      continue
    }

    if (verdict.score >= JEV_REVIEW_SCORE) {
      flagged.push(verdict.path)
      purposes[verdict.path] =
        `LLM ${verdict.score}/3, ${confidencePct}% confident — review${llmNote}` +
        formatReason(verdict.path)
      continue
    }

    dropped.push(verdict.path)
  }

  const orderedPaths = [...included, ...flagged]

  return {
    paths: orderedPaths,
    purposes,
    provider: providerId,
    model,
    mapTokens: countTokens(map.text),
    outputTokens: ranked.outputTokens,
    durationMs: Date.now() - started,
    hallucinated: [],
    method: 'gitnexus-llm',
    candidateCount: candidates.length,
    gitnexusMissing,
    jevScores: scoresByPath,
    jevConfidence: confidenceByPath,
    jevIncluded: included,
    jevFlagged: flagged,
    jevDropped: dropped,
  }
}

/**
 * Fallback model for a chat provider when the user has not picked one. The
 * catalogue is the same seed list the provider exposes in Settings; using
 * the first entry here keeps the two from drifting when a name is retired.
 */
function getDefaultModel(providerId: AiProviderId): string {
  switch (providerId) {
    case 'deepseek':
      return 'deepseek-flash'
    case 'groq':
      return 'llama-3.3-70b-versatile'
    case 'openrouter':
      return 'z-ai/glm-5.2:free'
    case 'google':
      return 'gemini-3.5-flash'
    default:
      return ''
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