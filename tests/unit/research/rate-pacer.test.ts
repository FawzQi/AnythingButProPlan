import { describe, expect, it, vi } from 'vitest'
import {
  SlidingWindowPacer,
  batchByTokenBudget,
} from '../../../src/main/services/research/rate-pacer'

describe('batchByTokenBudget', () => {
  it('returns empty batches when given empty list', () => {
    const { batches, batchTokenCounts } = batchByTokenBudget([], (item: string) => item)
    expect(batches).toEqual([])
    expect(batchTokenCounts).toEqual([])
  })

  it('splits items when token count exceeds maxTokens', () => {
    const items = ['hello world', 'another test item', 'third piece of text']
    // Each item is ~3-4 tokens. If maxTokens is set to 5, items should be split into multiple batches.
    const { batches } = batchByTokenBudget(items, (item) => item, {
      maxTokens: 5,
      maxChunks: 10,
    })

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(items)
  })

  it('splits items when chunk count reaches maxChunks', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    const { batches, batchTokenCounts } = batchByTokenBudget(items, (item) => item, {
      maxTokens: 1000,
      maxChunks: 2,
    })

    expect(batches).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(batchTokenCounts.length).toBe(3)
  })
})

describe('SlidingWindowPacer', () => {
  it('allows calls immediately when within rate limits', async () => {
    const pacer = new SlidingWindowPacer({
      maxTokensPerMinute: 1000,
      maxRequestsPerMinute: 10,
    })

    const onWait = vi.fn()
    await pacer.waitForQuota(100, onWait)
    await pacer.waitForQuota(200, onWait)

    expect(onWait).not.toHaveBeenCalled()
  })

  it('triggers onWait when token budget would be exceeded', async () => {
    const pacer = new SlidingWindowPacer({
      maxTokensPerMinute: 500,
      maxRequestsPerMinute: 10,
    })

    // Consume 400 tokens
    await pacer.waitForQuota(400)

    // Requesting 200 more tokens exceeds 500
    let waitCalledWith: number | undefined
    const checkCancelled = vi.fn()

    // Mock setTimeout or let it wait with checkCancelled returning true after 1 call
    checkCancelled.mockReturnValueOnce(false).mockReturnValueOnce(true)

    await pacer.waitForQuota(
      200,
      (secs) => {
        waitCalledWith = secs
      },
      checkCancelled,
    )

    expect(waitCalledWith).toBeDefined()
    expect(waitCalledWith).toBeGreaterThan(0)
  })

  it('allows a batch exceeding maxTokensPerMinute when window is empty without hanging', async () => {
    const pacer = new SlidingWindowPacer({
      maxTokensPerMinute: 500,
      maxRequestsPerMinute: 10,
    })

    const onWait = vi.fn()
    // 600 tokens exceeds the 500 limit, but window is empty
    await pacer.waitForQuota(600, onWait)
    expect(onWait).not.toHaveBeenCalled()
  })
})
