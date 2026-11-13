import { describe, expect, it } from 'vitest'
import {
  extractCodeBlocks,
  extractPlainBlocks,
  extractDeletePaths,
} from '../../../src/main/services/coding/response-parser/markdown-parser'
import { normalizePath, resolvePath } from '../../../src/main/services/coding/response-parser/path-heuristics'

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
    unterminated: false,
    ...overrides,
  })

  it('marks a single-file hint as ambiguous rather than guessing a name', () => {
    const hint = resolvePath(block({ precedingText: 'Here is the file:' }))
    expect(hint.path).toBeNull()
    expect(hint.ambiguous).toBe(true)
  })
})

describe('extractPlainBlocks', () => {
  it('stops at Delete: directives and does not absorb them into code content', () => {
    const input = `File: src/first.ts
const x = 1

Delete: src/old.ts

File: src/second.ts
const y = 2
`
    const blocks = extractPlainBlocks(input)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.content.trim()).toBe('const x = 1')
    expect(blocks[1]?.content.trim()).toBe('const y = 2')
  })
})

describe('extractDeletePaths', () => {
  it('extracts Delete: directives from prose', () => {
    const input = `I removed these files:
Delete: src/obsolete.ts
Delete: tests/legacy.test.ts
`
    expect(extractDeletePaths(input)).toEqual([
      'src/obsolete.ts',
      'tests/legacy.test.ts',
    ])
  })

  it('ignores Delete: lines inside fenced code blocks', () => {
    const input = `Delete: src/real-delete.ts
\`\`\`sql
DELETE: FROM users WHERE id = 1;
\`\`\`
`
    expect(extractDeletePaths(input)).toEqual(['src/real-delete.ts'])
  })

  it('ignores Delete: lines inside plaintext code blocks', () => {
    const input = `Delete: src/real-delete.ts
File: src/query.sql
DELETE: FROM users WHERE id = 1;

Delete: src/another-delete.ts
`
    expect(extractDeletePaths(input)).toEqual([
      'src/real-delete.ts',
      'src/another-delete.ts',
    ])
  })

  it('ignores Delete: lines inside SEARCH/REPLACE patches', () => {
    const input = `File: src/clean.ts
<<<<<<< SEARCH
DELETE: FROM old_table;
=======
TRUNCATE TABLE old_table;
>>>>>>> REPLACE

Delete: src/target.ts
`
    expect(extractDeletePaths(input)).toEqual(['src/target.ts'])
  })
})
