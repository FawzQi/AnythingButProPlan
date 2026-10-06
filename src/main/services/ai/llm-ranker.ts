import { countTokens } from 'gpt-tokenizer'
import type { AiProviderId } from '@shared/types'
import { getProvider } from './ai-providers'
import { describeFetchError } from './ai-providers/http'
import { asObjectList, extractJsonObject } from '../coding/json-salvage'

/**
 * LLM precision pass for the `gitnexus-llm` suggestion method.
 *
 * The recall half of that pipeline is identical to `gitnexus-only`: GitNexus
 * graph queries plus a BM25 index over a shallow per-file preview, merged and
 * reranked by git recency and co-change locality. The reranker narrows the
 * whole repository down to a few dozen candidates, but it cannot decide
 * *relevance* — a file that shares a few tokens with the instruction and was
 * touched recently scores well even if it has nothing to do with the change.
 *
 * Jev solves that with a typed `Score` question and a calibrated confidence.
 * An ordinary chat model cannot produce calibrated confidences, so this
 * module asks a different question instead: a single 0–3 rating per file, in
 * the same shape, with a `confidence` field the model fills in from its own
 * judgment. The threshold table then routes those ratings exactly the way it
 * routes Jev's, so the two methods are interchangeable from the UI's point
 * of view.
 *
 * Batching: the candidates and their skeletons are packed into a single
 * request. Unlike Jev, which bills per question and can be batched cheaply,
 * a chat completion is billed per token either way, so splitting into
 * multiple calls only adds latency and round-trip failures. The instruction
 * asks for strict JSON, but the parser tolerates the drift real models
 * produce — a fenced `json` block, a trailing comma, a stray `assistant:`
 * prefix — because a strict parse failure here would silently drop the whole
 * verdict and give the user zero files.
 */

export interface LlmCandidate {
  path: string
  skeleton: string
}

export interface LlmVerdict {
  path: string
  /** 0–3 relevance rating, matching the Jev rubric's scale. */
  score: number
  /** Model's self-reported confidence, 0–1. Not calibrated. */
  confidence: number
  /** Optional one-line reason the model gave, surfaced in the UI. */
  reason?: string
}

export interface LlmRankRequest {
  apiKey: string
  provider: AiProviderId
  model: string
  instruction: string
  candidates: LlmCandidate[]
}

export interface LlmRankResult {
  verdicts: LlmVerdict[]
  inputTokens: number
  outputTokens: number
}

const MAX_CANDIDATES_PER_CALL = 40

const SYSTEM_PROMPT = [
  'You rate how relevant each file in a repository is to a code-change request.',
  '',
  'For every file you are shown, output a rating on this exact scale:',
  '  0 = unrelated to the instruction',
  '  1 = tangential mention only, unlikely to need changes',
  '  2 = probably involved in the change',
  '  3 = directly relevant, very likely to need changes',
  '',
  'Also output a confidence between 0 and 1 for your rating, and a short',
  'reason of at most 15 words. Higher confidence means you are more certain',
  'the rating is correct.',
  '',
  'Reply with ONLY a JSON object of the form:',
  '{"files":[{"path":"<path>","score":<0-3>,"confidence":<0-1>,"reason":"<why>"}]}',
  '',
  'Include one entry for every file you were shown. Do not add prose,',
  'commentary, or markdown fences around the JSON.',
].join('\n')

/**
 * One call per batch. The instruction is repeated in the user message
 * because some providers weight the last message most heavily, and the file
 * list is what changes between batches.
 */
function buildUserMessage(
  instruction: string,
  candidates: LlmCandidate[],
): string {
  const blocks = candidates
    .map(
      (candidate, index) =>
        `### File ${index + 1}: ${candidate.path}\n\`\`\`\n${candidate.skeleton}\n\`\`\``,
    )
    .join('\n\n')
  return [
    `Change request:\n${instruction}`,
    '',
    `Rate the relevance of each of the ${candidates.length} file(s) below:`,
    '',
    blocks,
  ].join('\n')
}

/**
 * Coerce a model-produced score to an integer in [0, 3]. Providers vary in
 * how they honour a numeric range: some return floats, some return strings,
 * a few wrap the value in a one-element array. Anything unrecognisable
 * becomes 0, which routes the file to the "dropped" bucket rather than
 * silently marking it relevant.
 */
function coerceScore(value: unknown): number {
  let raw: unknown = value
  if (Array.isArray(raw)) raw = raw[0]
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(3, Math.round(num)))
}

function coerceConfidence(value: unknown): number {
  let raw: unknown = value
  if (Array.isArray(raw)) raw = raw[0]
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(1, num))
}

interface RawEntry {
  path?: unknown
  score?: unknown
  confidence?: unknown
  reason?: unknown
}

/**
 * Exported for the unit test — the drift shapes real models produce are the
 * one part of this module that cannot be checked by reading it, and they are
 * also the part that silently drops the whole verdict when it goes wrong.
 */
export function parseVerdicts(
  raw: string,
  known: Set<string>,
): LlmVerdict[] {
  const parsed = extractJsonObject(raw)
  if (parsed === null) return []

  const list = asObjectList(parsed, 'files', 'results')

  const verdicts: LlmVerdict[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as RawEntry
    const path = typeof record.path === 'string' ? record.path : null
    if (path === null || !known.has(path) || seen.has(path)) continue
    seen.add(path)
    verdicts.push({
      path,
      score: coerceScore(record.score),
      confidence: coerceConfidence(record.confidence),
      reason:
        typeof record.reason === 'string' && record.reason.trim() !== ''
          ? record.reason.trim()
          : undefined,
    })
  }
  return verdicts
}

/**
 * Ask a chat model to rate each candidate. The provider is whatever the user
 * selected in Settings for chat completions — DeepSeek, Groq, OpenRouter, or
 * Google AI Studio — and the model is the provider's configured default
 * unless the user has overridden it.
 *
 * A candidate the model did not return a verdict for is treated as score 0:
 * absent from the output is not evidence of relevance, and the UI would
 * otherwise have to distinguish "no verdict" from "zero verdict" for every
 * file in the list.
 */
export async function rankCandidatesWithLlm(
  request: LlmRankRequest,
): Promise<LlmRankResult> {
  const { apiKey, provider, model, instruction, candidates } = request
  if (candidates.length === 0) {
    return { verdicts: [], inputTokens: 0, outputTokens: 0 }
  }

  const providerImpl = getProvider(provider)
  const known = new Set(candidates.map((candidate) => candidate.path))
  const verdicts: LlmVerdict[] = []
  let inputTokens = 0
  let outputTokens = 0

  for (let i = 0; i < candidates.length; i += MAX_CANDIDATES_PER_CALL) {
    const batch = candidates.slice(i, i + MAX_CANDIDATES_PER_CALL)
    const user = buildUserMessage(instruction, batch)
    inputTokens += countTokens(SYSTEM_PROMPT) + countTokens(user)

    let response: string
    try {
      response = await providerImpl.complete({
        apiKey,
        model,
        system: SYSTEM_PROMPT,
        user,
        // The verdict JSON is small — one short object per candidate — but
        // the system prompt plus the file list is the real payload, and the
        // reasoning-model budget bump in `openai-compatible.ts` applies on
        // top of this. 4096 covers the largest batch with slack.
        maxTokens: 4096,
        temperature: 0,
      })
    } catch (error) {
      // The provider already formats a user-readable message for the common
      // failure modes (proxy, timeout, empty reasoning output). Wrap it so
      // the UI can attribute the failure to the ranking pass specifically.
      const detail =
        error instanceof Error ? error.message : String(error)
      throw new Error(`LLM ranking failed: ${detail}`, { cause: error })
    }

    outputTokens += countTokens(response)
    verdicts.push(...parseVerdicts(response, known))
  }

  // Any candidate the model skipped gets an explicit zero so the routing
  // logic sees a complete mapping. Without this the caller would need to
  // merge two lists; with it, the verdict list is a superset of what the
  // model returned and the routing loop is unchanged from the Jev path.
  const seen = new Set(verdicts.map((verdict) => verdict.path))
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue
    verdicts.push({ path: candidate.path, score: 0, confidence: 0 })
  }

  return { verdicts, inputTokens, outputTokens }
}

/**
 * Re-exported for callers that want to format a provider-shaped error the
 * same way the HTTP layer does. Kept here rather than imported at each call
 * site so the ranking pass and the chat provider agree on the wording.
 */
export { describeFetchError }