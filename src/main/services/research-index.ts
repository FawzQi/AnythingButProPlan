import { promises as fs } from 'node:fs'
import type {
  IndexBuildProgress,
  IndexBuildResult,
  IndexStatus,
} from '@shared/types'
import { isCancelled } from './cancellation'
import { chunkMarkdown, type Chunk } from './chunker'
import {
  indexPath,
  markdownPathFor,
  readIndexStatus,
  readState,
  scanDocuments,
  writeState,
} from './document-scanner'
import { getApiKey, resolveModel } from './settings'
import { getProvider } from './ai-providers'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './ai-providers/google'
import { VectorStore } from './vector-store'

/**
 * Build the retrieval index for the converted documents.
 *
 * Google is the only embedding provider, and that is a decision rather than a
 * gap: every embedding model produces vectors in its own space, so a second
 * provider means either a second index or re-embedding the whole corpus on
 * switch. At 20–200 documents there is no user-visible benefit worth that.
 * See CLAUDE.md, "Embeddings".
 *
 * Requests are batched at 100 — the `batchEmbedContents` limit — and each
 * batch is one HTTP call. Cancellation is checked between batches, so a
 * cancelled build discards the work in flight and leaves the previous index
 * on disk untouched: a half-written index would silently retrieve from a
 * partial corpus, which is worse than no new index at all.
 *
 * ponytail: full rebuild every time. Embedding a 200-document corpus costs
 * real money and minutes; make it incremental (reuse vectors for documents
 * whose chunk texts are unchanged, keyed by a content hash per document) when
 * rebuilds become a routine action rather than a rare one.
 */
const EMBED_BATCH = 100

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
      'The retrieval index needs a Google AI Studio key — text-embedding-004 is the ' +
        'embedding model this app builds with. Add the key in Settings.',
    )
  }
  const embedder = getProvider('google').embed
  if (embedder === undefined) {
    throw new Error('The Google provider is missing its embedding endpoint.')
  }
  const model = await resolveModel('google', EMBEDDING_MODEL)

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

  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
    if (isCancelled(projectRoot)) {
      return { index: await readIndexStatus(projectRoot), skipped, cancelled: true }
    }
    const batch = chunks.slice(offset, offset + EMBED_BATCH)
    // The heading path is embedded with the text but stored separately. A
    // chunk lifted from the middle of section 3 rarely names its own topic;
    // the heading is what makes "3.2 Data Collection" match a question about
    // sampling, and the citation still quotes the heading on its own.
    const vectors = await embedder({
      apiKey,
      model,
      texts: batch.map((chunk) =>
        chunk.headingPath === ''
          ? chunk.text
          : `${chunk.headingPath}\n\n${chunk.text}`,
      ),
    })
    store.add(batch, vectors)
    onProgress({
      stage: 'embedding',
      done: Math.min(offset + EMBED_BATCH, chunks.length),
      total: chunks.length,
      message: `Embedded ${Math.min(offset + EMBED_BATCH, chunks.length)} / ${chunks.length} chunks`,
    })
  }

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
