import { promises as fs } from 'node:fs'
import type {
  IndexBuildProgress,
  IndexBuildResult,
  IndexStatus,
} from '@shared/types'
import { isCancelled } from '../core/cancellation'
import { chunkMarkdown, type Chunk } from './chunker'
import {
  indexPath,
  markdownPathFor,
  readIndexStatus,
  readState,
  scanDocuments,
  writeState,
} from './document-scanner'
import { getApiKey } from '../core/settings'
import { getProvider } from '../ai/ai-providers'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../ai/ai-providers/google'
import { VectorStore } from './vector-store'
import { SlidingWindowPacer, batchByTokenBudget } from './rate-pacer'

/**
 * Build the retrieval index for the converted documents.
 *
 * Google is the only embedding provider, and that is a decision rather than a
 * gap: every embedding model produces vectors in its own space, so a second
 * provider means either a second index or re-embedding the whole corpus on
 * switch. At 20–200 documents there is no user-visible benefit worth that.
 * See CLAUDE.md, "Embeddings".
 *
 * Batches are sized dynamically by token budget (<= 15,000 tokens & <= 50 chunks)
 * and regulated by a sliding 60-second rate pacer to comfortably respect Google's
 * 30K TPM and 100 RPM quotas without 429 throttling. Unchanged chunks from
 * previous index runs with the same model are reused to conserve RPD quota.
 */

export interface BuildIndexRequest {
  projectRoot: string
  docPaths: string[]
  onProgress: (progress: IndexBuildProgress) => void
}

export async function buildIndex(
  request: BuildIndexRequest,
): Promise<IndexBuildResult & { cancelled: boolean }> {
  const { projectRoot, onProgress } = request

  const apiKey = await getApiKey('google')
  if (apiKey === null || apiKey === '') {
    throw new Error(
      `The retrieval index needs a Google AI Studio key — ${EMBEDDING_MODEL} is the ` +
        'embedding model this app builds with. Add the key in Settings.',
    )
  }
  const embedder = getProvider('google').embed
  if (embedder === undefined) {
    throw new Error('The Google provider is missing its embedding endpoint.')
  }
  // The index is only valid for the vector space it was built with, so the
  // model is pinned to the embedding model rather than taken from the user's
  // chat-model selection for Google.
  const model = EMBEDDING_MODEL

  const scan = await scanDocuments(projectRoot)
  const wanted =
    request.docPaths.length === 0
      ? scan.documents.map((document) => document.path)
      : request.docPaths

  const skipped: string[] = []
  const chunks: Chunk[] = []

  onProgress({
    stage: 'chunking',
    done: 0,
    total: wanted.length,
    message: 'Reading converted documents',
  })

  for (const [position, documentPath] of wanted.entries()) {
    const entry = scan.documents.find(
      (candidate) => candidate.path === documentPath,
    )
    if (entry === undefined || !entry.convertedExists) {
      // Reported, never silently dropped: the caller shows which documents
      // were left out and why.
      skipped.push(documentPath)
      continue
    }
    const markdown = await fs.readFile(
      markdownPathFor(projectRoot, entry.slug),
      'utf8',
    )
    chunks.push(...chunkMarkdown(documentPath, markdown))
    onProgress({
      stage: 'chunking',
      done: position + 1,
      total: wanted.length,
      message: `Chunked ${documentPath}`,
    })
  }

  if (chunks.length === 0) {
    throw new Error(
      skipped.length > 0
        ? `Nothing to index — ${skipped.length} document(s) have not been converted yet.`
        : 'Nothing to index — no converted documents were found.',
    )
  }

  const store = new VectorStore()

  // 1. Check existing index for cached vectors with the same model
  const existingStore = new VectorStore()
  let cachedVectors = new Map<string, number[]>()
  try {
    const loaded = await existingStore.load(indexPath(projectRoot))
    if (loaded && existingStore.getModel() === model) {
      cachedVectors = existingStore.getCachedVectors()
    }
  } catch {
    cachedVectors = new Map()
  }

  // 2. Separate chunks into cached vs needing embedding
  const chunksToEmbed: Chunk[] = []
  const vectorMap = new Map<string, number[]>()

  for (const chunk of chunks) {
    const key = `${chunk.document}:${chunk.headingPath}:${chunk.text}`
    const cached = cachedVectors.get(key)
    if (cached) {
      vectorMap.set(key, cached)
    } else {
      chunksToEmbed.push(chunk)
    }
  }

  let completedCount = chunks.length - chunksToEmbed.length

  if (completedCount > 0) {
    onProgress({
      stage: 'embedding',
      done: completedCount,
      total: chunks.length,
      message: `Reused ${completedCount} / ${chunks.length} cached embeddings`,
    })
  }

  // 3. Batch and pace newly needed chunks
  if (chunksToEmbed.length > 0) {
    const { batches, batchTokenCounts } = batchByTokenBudget(
      chunksToEmbed,
      (chunk) =>
        chunk.headingPath === ''
          ? chunk.text
          : `${chunk.headingPath}\n\n${chunk.text}`,
    )

    const pacer = new SlidingWindowPacer()

    for (const [batchIndex, batch] of batches.entries()) {
      if (isCancelled(projectRoot)) {
        return { index: await readIndexStatus(projectRoot), skipped, cancelled: true }
      }

      const tokensNeeded = batchTokenCounts[batchIndex] ?? 0

      await pacer.waitForQuota(
        tokensNeeded,
        (secondsRemaining) => {
          onProgress({
            stage: 'embedding',
            done: completedCount,
            total: chunks.length,
            message: `Pacing rate limit: waiting ${secondsRemaining}s for Gemini TPM quota…`,
          })
        },
        () => isCancelled(projectRoot),
      )

      if (isCancelled(projectRoot)) {
        return { index: await readIndexStatus(projectRoot), skipped, cancelled: true }
      }

      const batchTexts = batch.map((chunk) =>
        chunk.headingPath === ''
          ? chunk.text
          : `${chunk.headingPath}\n\n${chunk.text}`,
      )

      const vectors = await embedder({
        apiKey,
        model,
        texts: batchTexts,
      })

      for (const [idx, chunk] of batch.entries()) {
        const vec = vectors[idx]
        if (vec) {
          const key = `${chunk.document}:${chunk.headingPath}:${chunk.text}`
          vectorMap.set(key, vec)
        }
      }

      completedCount += batch.length
      onProgress({
        stage: 'embedding',
        done: completedCount,
        total: chunks.length,
        message: `Embedded ${completedCount} / ${chunks.length} chunks (${chunks.length - chunksToEmbed.length} cached)`,
      })
    }
  }

  // 4. Align vectors to chunks
  const allVectors: number[][] = chunks.map((chunk) => {
    const key = `${chunk.document}:${chunk.headingPath}:${chunk.text}`
    const vec = vectorMap.get(key)
    if (!vec) {
      throw new Error(`Missing vector for chunk ${chunk.id}`)
    }
    return vec
  })

  store.add(chunks, allVectors)

  if (store.getDimensions() !== EMBEDDING_DIMENSIONS) {
    // Not fatal — Google could return a different width for a future model —
    // but the index records what it actually got, and the read path compares
    // against the stored value rather than this constant.
    console.warn(
      `Embedding dimensions ${store.getDimensions()} differ from the expected ${EMBEDDING_DIMENSIONS} for ${model}.`,
    )
  }

  onProgress({
    stage: 'saving',
    done: chunks.length,
    total: chunks.length,
    message: 'Writing index',
  })
  await store.persist(indexPath(projectRoot), model)

  // Record per-document chunk counts so the document list can show what each
  // document contributed without loading the index.
  const state = await readState(projectRoot)
  for (const documentPath of new Set(chunks.map((chunk) => chunk.document))) {
    const entry = scan.documents.find(
      (candidate) => candidate.path === documentPath,
    )
    if (entry === undefined) continue
    const count = chunks.filter((chunk) => chunk.document === documentPath).length
    const record = state[entry.slug]
    if (record === undefined) continue
    state[entry.slug] = { ...record, chunkCount: count }
  }
  await writeState(projectRoot, state)

  const index: IndexStatus = await readIndexStatus(projectRoot)
  return { index, skipped, cancelled: false }
}