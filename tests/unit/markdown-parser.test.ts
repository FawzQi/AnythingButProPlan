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

  it('accepts tildes and captures three lines of preceding text', () => {
    const blocks = extractCodeBlocks('one\ntwo\nthree\nfour\n~~~py\nx = 1\n~~~')
    expect(blocks[0]?.language).toBe('py')
    expect(blocks[0]?.precedingText).toBe('two\nthree\nfour')
    expect(blocks[0]?.startLine).toBe(5)
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

  it('prefers the explicit XML path over everything else', () => {
    const hint = resolvePath(block({ content: '// File: wrong.ts\nconst a = 1' }), {
      explicitPath: 'src/right.ts',
    })
    expect(hint).toEqual({ path: 'src/right.ts', source: 'xml', ambiguous: false })
  })

  it('marks a single-file hint as ambiguous rather than guessing a name', () => {
    const hint = resolvePath(block({ precedingText: 'Here is the file:' }))
    expect(hint.path).toBeNull()
    expect(hint.ambiguous).toBe(true)
  })
})
