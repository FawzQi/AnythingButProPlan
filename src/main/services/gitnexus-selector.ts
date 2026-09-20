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
import { Bm25Index, type SemanticHit } from './semantic-index'
import { resolveWithinRoot } from './fs-service'
import { parseSuggestedFiles } from './file-selector'

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
  const history = await readRecentGitHistory(request.projectRoot)
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
  const gitnexusStatus = await checkGitNexus()
  const gitnexusHits = gitnexusStatus.available
    ? await queryGitNexus(request.projectRoot, terms, 60)
    : []
  const index = await buildShallowIndex(request.projectRoot, request.filePaths)
  const bm25Hits = index.search(terms.join(' '), 60)

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
      gitnexusMissing: !gitnexusStatus.available,
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
    gitnexusMissing: !gitnexusStatus.available,
  }
}