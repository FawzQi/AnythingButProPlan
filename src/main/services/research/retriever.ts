import { promises as fs } from 'node:fs'
import type { AiProviderId } from '@shared/types'
import { getApiKey, getSettings, resolveModel } from '../core/settings'
import { getProvider } from '../ai/ai-providers'
import { EMBEDDING_MODEL } from '../ai/ai-providers/google'
import { asObjectList, extractJsonObject } from '../coding/json-salvage'
import { indexPath, markdownPathFor } from './document-scanner'
import { VectorStore, type VectorHit } from './vector-store'

/**
 * Question → excerpts, for RAG research prompts.
 *
 * The pipeline is: embed the question, take a generous cosine shortlist, then
 * (optionally) let a chat model cut that shortlist down. The two stages exist
 * for different reasons. Cosine similarity is good at recall and bad at
 * judgement — it will happily return six near-identical chunks from the same
 * section because they all sit close to the question in embedding space. The
 * rerank stage is what turns six near-identical chunks into one chunk from
 * each of six relevant sections.
 *
 * The rerank is optional and off by default because it costs a provider call
 * and because for a five-document corpus the shortlist is already the answer.
 * It earns its place on a large corpus with a vague question.
 */

/** Candidates pulled from the vector store before reranking. */
const CANDIDATE_LIMIT = 30

export interface RetrieveRequest {
  projectRoot: string
  question: string
  /** Restrict retrieval to these `docs/`-relative paths. Empty = all. */
  documentPaths: string[]
  /** Excerpts to keep. */
  topK: number
  rerank: boolean
}

export interface RetrieveResult {
  hits: VectorHit[]
  /** Candidates considered before the rerank narrowed them. */
  candidateCount: number
  /** True when a chat model chose the final set. */
  reranked: boolean
  rerankWarning?: string
}

export async function loadStore(projectRoot: string): Promise<VectorStore> {
  const store = new VectorStore()
  await store.load(indexPath(projectRoot))
  return store
}

export async function embedQuestion(question: string): Promise<number[]> {
  const apiKey = await getApiKey('google')
  if (apiKey === null || apiKey === '') {
    throw new Error(
      'Retrieval needs a Google AI Studio key for the question embedding. ' +
        'Add one in Settings, or switch the prompt to full-document mode.',
    )
  }
  const embedder = getProvider('google').embed
  if (embedder === undefined) {
    throw new Error('The Google provider is missing its embedding endpoint.')
  }
  const model = await resolveModel('google', EMBEDDING_MODEL)
  const [vector] = await embedder({ apiKey, model, texts: [question] })
  if (vector === undefined) {
    throw new Error('The embedding endpoint returned no vector for the question.')
  }
  return vector
}

export async function retrieve(
  request: RetrieveRequest,
): Promise<RetrieveResult> {
  const store = await loadStore(request.projectRoot)
  if (store.size === 0) {
    throw new Error(
      'No retrieval index yet. Build one from the Index tab before using a RAG prompt.',
    )
  }

  const vector = await embedQuestion(request.question)
  const allowed =
    request.documentPaths.length === 0 ? null : new Set(request.documentPaths)

  const shortlist = store
    .query(vector, CANDIDATE_LIMIT)
    .filter((hit) => allowed === null || allowed.has(hit.chunk.document))

  if (shortlist.length === 0) {
    return { hits: [], candidateCount: 0, reranked: false }
  }

  if (!request.rerank || shortlist.length <= request.topK) {
    return {
      hits: shortlist.slice(0, request.topK),
      candidateCount: shortlist.length,
      reranked: false,
    }
  }

  try {
    const chosen = await rerank(request, shortlist)
    return { hits: chosen, candidateCount: shortlist.length, reranked: true }
  } catch (error) {
    // A failed rerank must not fail the prompt: the cosine shortlist is a
    // perfectly usable answer, just a blunter one. The caller shows the
    // warning beside the prompt so the user knows which ranking they got.
    return {
      hits: shortlist.slice(0, request.topK),
      candidateCount: shortlist.length,
      reranked: false,
      rerankWarning: error instanceof Error ? error.message : String(error),
    }
  }
}

interface RerankEntry {
  n?: unknown
}

/**
 * Ask a chat model to pick the best `topK` of the shortlist.
 *
 * The model sees numbered excerpts and answers with numbers, not text: it
 * never rewrites or quotes the content, so the excerpts in the final prompt
 * are the originals. A model that paraphrased here would corrupt the
 * citations the whole feature is built around.
 */
async function rerank(
  request: RetrieveRequest,
  shortlist: VectorHit[],
): Promise<VectorHit[]> {
  const settings = await getSettings()
  const providerId: AiProviderId = settings.provider ?? 'deepseek'
  const apiKey = await getApiKey(providerId)
  if (apiKey === null || apiKey === '') {
    throw new Error(`No API key saved for ${providerId}.`)
  }
  const provider = getProvider(providerId)
  // Fall back to the provider's first seed model when the user has not
  // chosen one. Passing an empty string through to the vendor produces a
  // "model not found" failure at request time, and because the rerank pass
  // is the last step before the prompt is built, that failure surfaces as
  // a warning banner rather than an error the user can act on. The seed
  // list is the same catalogue `Settings` shows, so the fallback is the
  // model the picker would have defaulted to anyway.
  const model = await resolveModel(providerId, provider.models[0] ?? '')

  const listing = shortlist
    .map(
      (hit, index) =>
        `[${index + 1}] ${hit.chunk.document} — ${hit.chunk.headingPath || '(no heading)'}\n${hit.chunk.text.slice(0, 400)}`,
    )
    .join('\n\n')

  const response = await provider.complete({
    apiKey,
    model,
    system: [
      'You pick which excerpts from a document set best answer a question.',
      `Reply with ONLY a JSON object listing the numbers of the ${request.topK} best excerpts, best first:`,
      '{"picks":[3,1,7]}',
      'Pick at most one excerpt per section when several say the same thing.',
      'Do not explain, do not quote the excerpts, do not add prose.',
    ].join('\n'),
    user: `Question: ${request.question}\n\nExcerpts:\n\n${listing}`,
    maxTokens: 512,
    temperature: 0,
  })

  const parsed = extractJsonObject(response)
  const picks = asObjectList(parsed, 'picks', 'excerpts', 'results')
    .map((entry: unknown) => {
      if (typeof entry === 'number') return entry
      if (entry !== null && typeof entry === 'object') {
        const value = (entry as RerankEntry).n
        return typeof value === 'number' ? value : NaN
      }
      return NaN
    })
    .filter((value: unknown): value is number => typeof value === 'number' && Number.isInteger(value))

  const seen = new Set<number>()
  const chosen: VectorHit[] = []
  for (const pick of picks) {
    const hit = shortlist[pick - 1]
    if (hit === undefined || seen.has(pick)) continue
    seen.add(pick)
    chosen.push(hit)
    if (chosen.length === request.topK) break
  }
  if (chosen.length === 0) {
    throw new Error('The rerank model returned no usable picks.')
  }
  return chosen
}

/**
 * The opening paragraph(s) of a document, used as the per-document preamble
 * in a RAG prompt.
 *
 * This is not decoration and is not optional. A 300-token excerpt from the
 * middle of a paper refers to concepts defined pages earlier — "the proposed
 * method", "as described above", "these three datasets" — and without the
 * abstract the model reads the excerpt as a standalone claim and produces an
 * answer that misattributes it. The abstract is what makes the excerpt
 * interpretable.
 *
 * Extractors label abstracts differently (some emit `## Abstract`, some emit
 * a bold run-in heading, some just start with the paper's first paragraph),
 * so this takes the explicitly labelled one when present and otherwise falls
 * back to the first block of prose, capped so a preamble cannot crowd out the
 * excerpts it exists to support.
 */
export function extractAbstract(markdown: string): string {
  const labelled =
    /^#{0,6}\s*\**\s*abstract\s*\**\s*:?\s*$/im.exec(markdown)
  if (labelled !== null) {
    const rest = markdown.slice(labelled.index + labelled[0].length)
    const stop = /^#{1,6}\s+\S/m.exec(rest)
    const body = (stop === null ? rest : rest.slice(0, stop.index)).trim()
    if (body !== '') return truncate(body, 1200)
  }

  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        paragraph !== '' &&
        // Skip the title block and any heading or figure line that happens to
        // sit first; the preamble should be prose.
        !paragraph.startsWith('#') &&
        !paragraph.startsWith('!') &&
        !paragraph.startsWith('>'),
    )
  const first = paragraphs[0] ?? ''
  return truncate(first, 1200)
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  // Cut at a sentence boundary near the limit rather than mid-word.
  const slice = text.slice(0, limit)
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
  )
  return lastStop > limit * 0.5 ? slice.slice(0, lastStop + 1) : `${slice}…`
}

export interface DocumentPreamble {
  path: string
  abstract: string
}

/** Abstracts for the documents a prompt will draw on, in `docPaths` order. */
export async function collectAbstracts(
  projectRoot: string,
  documents: { path: string; slug: string }[],
): Promise<DocumentPreamble[]> {
  const preambles: DocumentPreamble[] = []
  for (const document of documents) {
    try {
      const markdown = await fs.readFile(
        markdownPathFor(projectRoot, document.slug),
        'utf8',
      )
      preambles.push({
        path: document.path,
        abstract: extractAbstract(markdown),
      })
    } catch {
      // A document that cannot be read is left out of the preamble list; the
      // caller has already collected the same failure as `unreadable` from
      // the excerpt stage, so it is reported once, not twice.
    }
  }
  return preambles
}