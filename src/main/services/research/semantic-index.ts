/**
 * Minimal BM25 index over a set of per-file documents.
 *
 * The pipeline uses this as the "semantic/vector fallback": when GitNexus
 * has nothing (or the tool is not installed), a keyword-overlap search still
 * catches conceptual matches — a request about "sluggish login" pulls in
 * files that mention `auth`, `session`, `latency`, and so on, even when no
 * symbol matches a term directly.
 *
 * There is no embedding model in the main process — it would need a native
 * dependency and a model download, and the whole point of this path is to
 * stay local and free. BM25 over a shallow per-file preview is the
 * pragmatic stand-in. The caller decides what goes in the documents; the
 * selector feeds it the first few kilobytes of each file, not the whole
 * body, so indexing a large repository stays fast.
 */

import { splitCompound, stemToken } from './query-expander'

export interface SemanticDoc {
  path: string
  text?: string
  /** Optional tokens extracted from file path and directory names (weighted higher). */
  pathTokens?: string[]
  /** Optional tokens extracted from exported symbols/declarations (weighted higher). */
  symbolTokens?: string[]
  /** Optional body preview text. */
  bodyPreview?: string
}

export type IndexedDoc = SemanticDoc

export interface SemanticHit {
  path: string
  score: number
}

interface StoredDoc {
  path: string
  tokens: string[]
  stemMap: Map<string, number>
  tokenCounts: Map<string, number>
  length: number
}

const K1 = 1.5
const B = 0.75

/**
 * Split text into lowercase tokens. camelCase, PascalCase, snake_case,
 * and compound words are split so `parseSuggestedFiles` contributes `parse`,
 * `suggested`, and `files` separately, and a query for `suggested files` matches it.
 */
export function tokenize(text: string): string[] {
  return splitCompound(text)
}

export class Bm25Index {
  private readonly docs: StoredDoc[]
  private readonly documentFrequency: Map<string, number>
  private readonly stemFrequency: Map<string, number>
  private readonly averageLength: number

  constructor(docs: SemanticDoc[]) {
    this.docs = docs.map((doc) => {
      const contentTokens = tokenize(`${doc.text ?? ''}\n${doc.bodyPreview ?? ''}`)
      const pathTokens = doc.pathTokens ?? tokenize(doc.path)
      const symbolTokens = doc.symbolTokens ?? []

      // Multi-channel weighted token counts:
      // Path tokens carry 3x weight, symbols 2x, body text 1x.
      const tokenCounts = new Map<string, number>()
      const stemMap = new Map<string, number>()

      const recordTokens = (tokens: string[], weight: number): void => {
        for (const token of tokens) {
          tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + weight)
          const stem = stemToken(token)
          stemMap.set(stem, (stemMap.get(stem) ?? 0) + weight)
        }
      }

      recordTokens(contentTokens, 1.0)
      recordTokens(pathTokens, 3.0)
      recordTokens(symbolTokens, 2.0)

      const allTokens = [...new Set([...contentTokens, ...pathTokens, ...symbolTokens])]
      return {
        path: doc.path,
        tokens: allTokens,
        tokenCounts,
        stemMap,
        length: contentTokens.length + pathTokens.length * 2,
      }
    })

    this.documentFrequency = new Map()
    this.stemFrequency = new Map()

    for (const doc of this.docs) {
      for (const token of doc.tokens) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        )
      }
      for (const stem of doc.stemMap.keys()) {
        this.stemFrequency.set(
          stem,
          (this.stemFrequency.get(stem) ?? 0) + 1,
        )
      }
    }

    const total = this.docs.reduce((sum, doc) => sum + doc.length, 0)
    this.averageLength = this.docs.length > 0 ? total / this.docs.length : 0
  }

  search(query: string, limit = 60): SemanticHit[] {
    const terms = tokenize(query)
    if (terms.length === 0 || this.docs.length === 0) return []

    const documentCount = this.docs.length
    const scored = this.docs.map((doc) => {
      let score = 0
      for (const term of terms) {
        const exactTf = doc.tokenCounts.get(term) ?? 0
        let termFrequency = exactTf

        // If exact term wasn't found, check stem match with 0.8x weight
        if (termFrequency === 0) {
          const stem = stemToken(term)
          const stemTf = doc.stemMap.get(stem) ?? 0
          if (stemTf > 0) termFrequency = stemTf * 0.8
        }
        if (termFrequency === 0) continue

        const df =
          this.documentFrequency.get(term) ??
          this.stemFrequency.get(stemToken(term)) ??
          1

        const idf = Math.log(
          1 + (documentCount - df + 0.5) / (df + 0.5),
        )

        const denominator =
          termFrequency +
          K1 *
            (1 - B + (B * doc.length) / (this.averageLength || 1))

        score += idf * ((termFrequency * (K1 + 1)) / denominator)
      }
      return { path: doc.path, score }
    })

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}