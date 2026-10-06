import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Chunk } from './chunker'
import { writeFileEnsuringDir } from '../core/fs-service'

/**
 * In-memory vector index with on-disk persistence.
 *
 * The whole corpus lives in RAM as a flat Float32Array, and a query is a
 * linear cosine scan. That is not a compromise at this scale: 200 documents
 * at roughly 150 chunks each is 30k vectors of 768 floats — about 90 MB, and
 * a scan over it takes a few milliseconds. A native vector database would add
 * a packaged binary, a platform matrix, and a migration story in exchange for
 * latency the user cannot perceive.
 *
 * The interface is deliberately the five operations a callable vector store
 * needs (`add`, `query`, `remove`, `persist`, `load`) so that swapping in one
 * later touches this file and nothing else. See CLAUDE.md, "Vector store" —
 * do not add a native dependency before the scale justifies it.
 *
 * Persistence layout under `.index/`:
 *
 *   chunks.json     chunk metadata, in vector order
 *   embeddings.bin  raw Float32, `dimensions` floats per chunk, index-aligned
 *   meta.json       dimensions, model, counts, build time
 *
 * The alignment between the two files is the whole contract: vector i belongs
 * to chunks[i]. A mismatch is detected on load (byte length vs count ×
 * dimensions) and reported as a corrupt index rather than silently pairing
 * chunks with the wrong vectors.
 */

export interface VectorHit {
  chunk: Chunk
  score: number
}

export interface StoreMeta {
  dimensions: number
  model: string | null
  documentCount: number
  chunkCount: number
  builtAt: number | null
}

const CHUNKS_FILE = 'chunks.json'
const VECTORS_FILE = 'embeddings.bin'
const META_FILE = 'meta.json'

export class VectorStore {
  private chunks: Chunk[] = []
  private vectors: Float32Array[] = []
  private dimensions = 0

  get size(): number {
    return this.chunks.length
  }

  getDimensions(): number {
    return this.dimensions
  }

  /** Distinct documents currently in the index, in insertion order. */
  documents(): string[] {
    const seen = new Set<string>()
    for (const chunk of this.chunks) seen.add(chunk.document)
    return [...seen]
  }

  clear(): void {
    this.chunks = []
    this.vectors = []
    this.dimensions = 0
  }

  /**
   * Add chunks with their vectors. A vector whose length disagrees with the
   * established dimensionality is rejected here rather than at query time —
   * a mismatched vector would make cosine throw on every search, long after
   * the call that introduced it.
   */
  add(chunks: Chunk[], vectors: number[][]): void {
    if (chunks.length !== vectors.length) {
      throw new Error(
        `VectorStore.add: ${chunks.length} chunks but ${vectors.length} vectors.`,
      )
    }
    for (const [index, vector] of vectors.entries()) {
      if (this.dimensions === 0 && vector.length > 0) {
        this.dimensions = vector.length
      }
      if (vector.length !== this.dimensions) {
        throw new Error(
          `VectorStore.add: vector ${index} has ${vector.length} dimensions, expected ${this.dimensions}.`,
        )
      }
      this.chunks.push(chunks[index] as Chunk)
      // Normalising here rather than in `query` is what keeps the query a
      // bare dot product: every stored vector is unit length, the query
      // vector is normalised once per search, and the score is the cosine.
      // Skipping it on one side only would scale every score by the stored
      // vector's length, which ranks by magnitude instead of direction.
      this.vectors.push(normalise(Float32Array.from(vector)))
    }
  }

  /** Drop every chunk belonging to one document. */
  remove(document: string): number {
    const keptChunks: Chunk[] = []
    const keptVectors: Float32Array[] = []
    for (const [index, chunk] of this.chunks.entries()) {
      if (chunk.document === document) continue
      keptChunks.push(chunk)
      keptVectors.push(this.vectors[index] as Float32Array)
    }
    const removed = this.chunks.length - keptChunks.length
    this.chunks = keptChunks
    this.vectors = keptVectors
    if (this.chunks.length === 0) this.dimensions = 0
    return removed
  }

  /**
   * Top-k by cosine similarity. Vectors are L2-normalised on insert (below),
   * so the dot product is the cosine and the scan is one multiply-add per
   * dimension.
   */
  query(vector: number[], limit: number): VectorHit[] {
    if (this.chunks.length === 0 || vector.length !== this.dimensions) return []
    const queryVector = normalise(Float32Array.from(vector))
    const scored: VectorHit[] = []

    for (const [index, stored] of this.vectors.entries()) {
      let dot = 0
      for (let i = 0; i < stored.length; i += 1) {
        dot += (stored[i] as number) * (queryVector[i] as number)
      }
      scored.push({ chunk: this.chunks[index] as Chunk, score: dot })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  async persist(
    directory: string,
    model: string,
  ): Promise<StoreMeta> {
    const meta: StoreMeta = {
      dimensions: this.dimensions,
      model,
      documentCount: this.documents().length,
      chunkCount: this.chunks.length,
      builtAt: Date.now(),
    }
    const flat = new Float32Array(this.chunks.length * this.dimensions)
    for (const [index, vector] of this.vectors.entries()) {
      flat.set(vector, index * this.dimensions)
    }
    await fs.mkdir(directory, { recursive: true })
    await writeFileEnsuringDir(
      path.join(directory, CHUNKS_FILE),
      `${JSON.stringify(this.chunks)}\n`,
    )
    await fs.writeFile(
      path.join(directory, VECTORS_FILE),
      Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength),
    )
    await writeFileEnsuringDir(
      path.join(directory, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
    )
    return meta
  }

  /**
   * Load a persisted index. Returns false when there is nothing to load, and
   * throws when what is on disk is inconsistent — those are different
   * outcomes and the caller reports them differently ("no index yet" versus
   * "the index is corrupt, rebuild it").
   */
  async load(directory: string): Promise<boolean> {
    this.clear()
    let chunksRaw: string
    let metaRaw: string
    let vectorBuffer: Buffer
    try {
      chunksRaw = await fs.readFile(path.join(directory, CHUNKS_FILE), 'utf8')
      metaRaw = await fs.readFile(path.join(directory, META_FILE), 'utf8')
      vectorBuffer = await fs.readFile(path.join(directory, VECTORS_FILE))
    } catch {
      return false
    }

    const chunks = JSON.parse(chunksRaw) as Chunk[]
    const meta = JSON.parse(metaRaw) as StoreMeta
    if (!Array.isArray(chunks) || chunks.length === 0) return false

    const expectedBytes = chunks.length * meta.dimensions * 4
    if (meta.dimensions === 0 || vectorBuffer.byteLength !== expectedBytes) {
      throw new Error(
        `Index is inconsistent: ${chunks.length} chunks at ${meta.dimensions} dimensions ` +
          `needs ${expectedBytes} bytes of vectors, found ${vectorBuffer.byteLength}. Rebuild the index.`,
      )
    }

    const flat = new Float32Array(
      vectorBuffer.buffer,
      vectorBuffer.byteOffset,
      vectorBuffer.byteLength / 4,
    )
    this.dimensions = meta.dimensions
    this.chunks = chunks
    this.vectors = chunks.map((_, index) =>
      normalise(flat.slice(index * meta.dimensions, (index + 1) * meta.dimensions)),
    )
    return true
  }
}

/**
 * Unit-length copy. Stored normalised so `query` is a bare dot product;
 * re-normalising on load keeps a hand-edited or foreign embeddings.bin from
 * producing similarity scores outside [-1, 1].
 */
function normalise(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0) return vector
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = (vector[i] as number) / norm
  }
  return vector
}
