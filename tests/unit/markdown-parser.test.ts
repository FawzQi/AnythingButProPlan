import { describe, expect, it } from 'vitest'
import { extractCodeBlocks } from '../../src/main/services/response-parser/markdown-parser'
import { normalizePath, resolvePath } from '../../src/main/services/response-parser/path-heuristics'

describe('extractCodeBlocks', () => {
  it('reads the info string as the language', () => {
    const blocks = extractCodeBlocks('```typescript\nconst a = 1\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.language).toBe('typescript')
    expect(blocks[0]?.content).toBe('const a = 1')
  })

  it('keeps a nested fence inside a longer fence', () => {
    const blocks = extractCodeBlocks('````md\n```bash\nls\n```\n````')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('```bash\nls\n```')
  })

  it('runs an unterminated fence to the end of input', () => {
    const blocks = extractCodeBlocks('```ts\nconst a = 1\nconst b = 2')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('const a = 1\nconst b = 2')
  })

  it('accepts tildes and captures the preceding text', () => {
    const blocks = extractCodeBlocks('one\ntwo\nthree\nfour\n~~~py\nx = 1\n~~~')
    expect(blocks[0]?.language).toBe('py')
    // The window is sized to cover the output contract's header + blank
    // line + fence plus drift; with four preceding lines, all four fit.
    expect(blocks[0]?.precedingText).toBe('one\ntwo\nthree\nfour')
    expect(blocks[0]?.startLine).toBe(5)
  })

  it('caps the preceding text at the configured window size', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const input = `${lines.join('\n')}\n~~~py\nx = 1\n~~~`
    const blocks = extractCodeBlocks(input)
    // PRECEDING_WINDOW = 6, so only the last six lines before the fence
    // are kept: c, d, e, f, g, h. The first two are outside the window.
    expect(blocks[0]?.precedingText).toBe('c\nd\ne\nf\ng\nh')
  })

  it('does not treat an inline fence as an opener', () => {
    expect(extractCodeBlocks('use ``` like this')).toEqual([])
  })
})

describe('normalizePath', () => {
  it('folds windows separators and strips ./ and leading slashes', () => {
    expect(normalizePath('src\\app.ts')).toBe('src/app.ts')
    expect(normalizePath('./src/app.ts')).toBe('src/app.ts')
    expect(normalizePath('/src/app.ts')).toBe('src/app.ts')
  })

  it('takes the trailing token out of prose', () => {
    expect(normalizePath('update src/app.ts now')).toBe('src/app.ts')
  })

  it('refuses traversal, absolute escapes, and non-paths', () => {
    expect(normalizePath('../secrets.ts')).toBeNull()
    expect(normalizePath('src/../../x.ts')).toBeNull()
    expect(normalizePath('no-extension')).toBeNull()
    expect(normalizePath('')).toBeNull()
  })
})

describe('resolvePath', () => {
  const block = (overrides: Partial<Parameters<typeof resolvePath>[0]> = {}) => ({
    language: 'typescript',
    content: 'const a = 1',
    precedingText: '',
    rawBlock: '',
    startLine: 1,
    ...overrides,
  })

  it('marks a single-file hint as ambiguous rather than guessing a name', () => {
    const hint = resolvePath(block({ precedingText: 'Here is the file:' }))
    expect(hint.path).toBeNull()
    expect(hint.ambiguous).toBe(true)
  })
})
