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

export interface SemanticDoc {
  path: string
  text: string
}

export interface SemanticHit {
  path: string
  score: number
}

interface IndexedDoc {
  path: string
  tokens: string[]
  length: number
}

const K1 = 1.5
const B = 0.75

/**
 * Split text into lowercase tokens. camelCase and PascalCase are split at
 * their case boundary first so `parseSuggestedFiles` contributes `parse`,
 * `suggested`, and `files` separately, and a query for `suggested files`
 * matches it.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const normalised = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  for (const piece of normalised.split(/[^a-z0-9_]+/)) {
    if (piece.length >= 2 && piece.length <= 40) out.push(piece)
  }
  return out
}

export class Bm25Index {
  private readonly docs: IndexedDoc[]
  private readonly documentFrequency: Map<string, number>
  private readonly averageLength: number

  constructor(docs: SemanticDoc[]) {
    this.docs = docs.map((doc) => {
      const tokens = tokenize(doc.text)
      return { path: doc.path, tokens, length: tokens.length }
    })

    this.documentFrequency = new Map()
    for (const doc of this.docs) {
      for (const token of new Set(doc.tokens)) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        )
      }
    }

    const total = this.docs.reduce((sum, doc) => sum + doc.length, 0)
    this.averageLength = this.docs.length > 0 ? total / this.docs.length : 0
  }

  search(query: string, limit = 40): SemanticHit[] {
    const terms = tokenize(query)
    if (terms.length === 0 || this.docs.length === 0) return []

    const documentCount = this.docs.length
    const scored = this.docs.map((doc) => {
      let score = 0
      for (const term of terms) {
        const df = this.documentFrequency.get(term) ?? 0
        if (df === 0) continue

        const idf = Math.log(
          1 + (documentCount - df + 0.5) / (df + 0.5),
        )

        let termFrequency = 0
        for (const token of doc.tokens) if (token === term) termFrequency += 1
        if (termFrequency === 0) continue

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