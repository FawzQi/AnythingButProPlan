import { countTokens } from 'gpt-tokenizer'

export interface RateLimits {
  /** Maximum tokens allowed in a rolling 60-second window. Default 25,000 (safe margin under 30k). */
  maxTokensPerMinute: number
  /** Maximum requests allowed in a rolling 60-second window. Default 80 (safe margin under 100). */
  maxRequestsPerMinute: number
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxTokensPerMinute: 25_000,
  maxRequestsPerMinute: 80,
}

export const DEFAULT_MAX_BATCH_TOKENS = 15_000
export const DEFAULT_MAX_BATCH_CHUNKS = 50

interface RequestRecord {
  timestamp: number
  tokens: number
}

/**
 * Sliding 60-second window rate pacer for token- and request-limited APIs.
 */
export class SlidingWindowPacer {
  private history: RequestRecord[] = []
  private limits: RateLimits

  constructor(limits: Partial<RateLimits> = {}) {
    this.limits = { ...DEFAULT_RATE_LIMITS, ...limits }
  }

  /**
   * Block until the requested token budget and 1 request slot are available
   * within the rolling 60-second window.
   */
  async waitForQuota(
    tokensNeeded: number,
    onWait?: (secondsRemaining: number) => void,
    checkCancelled?: () => boolean,
  ): Promise<void> {
    while (true) {
      if (checkCancelled && checkCancelled()) {
        return
      }

      const now = Date.now()
      this.history = this.history.filter((entry) => now - entry.timestamp < 60_000)

      const usedTokens = this.history.reduce((sum, entry) => sum + entry.tokens, 0)
      const usedRequests = this.history.length

      const windowEmpty = this.history.length === 0
      const tokensExceeded =
        !windowEmpty && usedTokens + tokensNeeded > this.limits.maxTokensPerMinute
      const requestsExceeded =
        usedRequests + 1 > this.limits.maxRequestsPerMinute

      if (!tokensExceeded && !requestsExceeded) {
        this.history.push({ timestamp: now, tokens: tokensNeeded })
        return
      }

      // Calculate time until oldest entry leaves the 60-second window
      const oldest = this.history[0]
      const waitMs = oldest
        ? Math.max(500, 60_000 - (now - oldest.timestamp) + 200)
        : 1000

      if (onWait) {
        onWait(Math.ceil(waitMs / 1000))
      }

      // Sleep in small increments (max 1s) to stay responsive to cancellations
      const sleepSlice = Math.min(waitMs, 1000)
      await new Promise((resolve) => setTimeout(resolve, sleepSlice))
    }
  }

  /** Clear all history (used in tests or resets). */
  reset(): void {
    this.history = []
  }
}

/**
 * Partition items into batches based on both token count and chunk count constraints.
 * Ensures no batch exceeds `maxTokens` (default 15k) or `maxChunks` (default 50).
 */
export function batchByTokenBudget<T>(
  items: T[],
  getText: (item: T) => string,
  options: {
    maxTokens?: number
    maxChunks?: number
    getTokenCount?: (item: T) => number
  } = {},
): { batches: T[][]; batchTokenCounts: number[] } {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_BATCH_TOKENS
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_BATCH_CHUNKS
  const getTokenCount =
    options.getTokenCount ?? ((item: T) => countTokens(getText(item)))

  const batches: T[][] = []
  const batchTokenCounts: number[] = []

  let currentBatch: T[] = []
  let currentTokens = 0

  for (const item of items) {
    const itemTokens = getTokenCount(item)

    const exceedsTokens =
      currentBatch.length > 0 && currentTokens + itemTokens > maxTokens
    const exceedsChunks = currentBatch.length >= maxChunks

    if (exceedsTokens || exceedsChunks) {
      batches.push(currentBatch)
      batchTokenCounts.push(currentTokens)
      currentBatch = []
      currentTokens = 0
    }

    currentBatch.push(item)
    currentTokens += itemTokens
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
    batchTokenCounts.push(currentTokens)
  }

  return { batches, batchTokenCounts }
}
