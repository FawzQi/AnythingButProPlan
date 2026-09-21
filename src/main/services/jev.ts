import { httpFetch, describeFetchError } from './ai-providers/http'

/**
 * Client for the TypeSafe Jev typed-decision API.
 *
 * Jev is not a chat model. It takes a piece of state plus a map of typed
 * questions and returns typed answers with calibrated probabilities. The
 * `Score` primitive used here places the state on a defined ordinal
 * spectrum — for file selection, a 0–3 relevance rating — and returns both
 * the probability-weighted position and the model's confidence in that
 * answer.
 *
 * Requests go through `httpFetch` (Chromium's network stack) for the same
 * reason the chat providers do: proxy support, Happy Eyeballs, and the OS
 * certificate store. See `ai-providers/http.ts`.
 *
 * The endpoint is `POST https://api.typesafe.ai/v1/systemone`. An earlier
 * version of this file used `/v1/decide`, which does not exist — TypeSafe
 * returns `{"detail":"Not Found"}` for it. The `systemone` path is the
 * documented evaluation endpoint and is what every gateway (LiteLLM,
 * Vercel AI Gateway, LLM Gateway, Venice) proxies to.
 *
 * The request body is `{ model, state, questions }` — note that `questions`
 * is a **map keyed by an id you choose**, not an array. Answers come back
 * under the same ids. The earlier array-of-questions shape with an `id`
 * field per question was rejected as a malformed body.
 *
 * Batch size is 20. TypeSafe's own examples batch 1–32 questions per
 * request; the smaller number keeps each request's state well inside the
 * 32K token limit when every candidate carries a skeleton section.
 */

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const JEV_BATCH_SIZE = 20
const JEV_TIMEOUT_MS = 45_000

export interface JevCandidate {
  path: string
  /** The skeleton section for this file — see `buildCodebaseMap`. */
  skeleton: string
}

export interface JevScore {
  path: string
  /** Probability-weighted position on the 0–3 rubric; may be fractional. */
  score: number
  /** The model's calibrated confidence in `score`, between 0 and 1. */
  confidence: number
}

export interface JevScoreRequest {
  apiKey: string
  model: string
  instruction: string
  candidates: JevCandidate[]
}

export interface JevScoreResult {
  results: JevScore[]
  /** Total input tokens billed across every batch, as reported by the API. */
  tokens: number
  /** Number of outbound API calls. Surfaced so the UI can show the cost. */
  batches: number
}

/**
 * The ordered rubric for the Score question. TypeSafe takes an array of
 * level descriptions, not `0 = …` strings — the level index is implied by
 * the array position, and the response returns both the weighted position
 * and a `legend` map back to these descriptions.
 */
const SCORE_CRITERIA = [
  'unrelated to the instruction',
  'tangential mention only, unlikely to change',
  'probably involved in the change',
  'directly relevant, very likely to need changes',
]

export async function scoreCandidatesWithJev(
  request: JevScoreRequest,
): Promise<JevScoreResult> {
  const { apiKey, model, instruction, candidates } = request
  if (candidates.length === 0) {
    return { results: [], tokens: 0, batches: 0 }
  }

  const batches = chunk(candidates, JEV_BATCH_SIZE)
  const results: JevScore[] = []
  let totalTokens = 0

  for (const batch of batches) {
    // The state is shared across every question in the request. Each
    // question's `instructions` carries the file-specific data it needs —
    // this is the documented way to ask multiple questions about different
    // parts of a structured state, since the state itself cannot vary per
    // question.
    const state = { instruction }

    const questions: Record<string, unknown> = {}
    for (const candidate of batch) {
      // The key is the file path — answers come back under the same key,
      // which is how a score maps back to a path without relying on array
      // order. TypeSafe does not send the key to the model.
      questions[candidate.path] = {
        type: 'score',
        instructions: {
          file: {
            path: candidate.path,
            skeleton: candidate.skeleton,
          },
          question:
            'Rate how relevant this file is to the instruction. ' +
            'Use the criteria exactly as given.',
        },
        criteria: SCORE_CRITERIA,
      }
    }

    const body = { model, state, questions }

    let response: Response
    try {
      response = await httpFetch(
        JEV_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        JEV_TIMEOUT_MS,
      )
    } catch (error) {
      throw new Error(describeFetchError('TypeSafe Jev', error))
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `TypeSafe Jev returned ${response.status}: ${
          detail.slice(0, 300) || response.statusText
        }`,
      )
    }

    const json = (await response.json()) as {
      model?: string
      answers?: Record<
        string,
        {
          type?: string
          score?: number
          legend?: Record<string, string>
          probabilities?: Record<string, number>
          confidence?: number
        }
      >
      usage?: { input_tokens?: number; output_tokens?: number }
    }

    // `answers` is a map keyed by the question id (the file path). The
    // Score answer carries a probability-weighted `score` that may land
    // between levels, plus a `confidence` derived from the distribution.
    for (const [path, answer] of Object.entries(json.answers ?? {})) {
      const score =
        typeof answer.score === 'number' && Number.isFinite(answer.score)
          ? answer.score
          : 0
      const confidence =
        typeof answer.confidence === 'number' &&
        Number.isFinite(answer.confidence)
          ? answer.confidence
          : 0
      results.push({ path, score, confidence })
    }

    const used = json.usage?.input_tokens
    if (typeof used === 'number' && Number.isFinite(used)) totalTokens += used
  }

  return { results, tokens: totalTokens, batches: batches.length }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}