import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseResponse } from '../../src/main/services/response-parser'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'responses')

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

describe('parseResponse — strategy cascade', () => {
  it('takes the strict XML envelope, verbatim', () => {
    const result = parseResponse(fixture('clean-xml.txt'))

    expect(result.strategy).toBe('xml')
    expect(result.warnings).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files[0]?.pathSource).toBe('xml')
    // No blank line before the closing fence in the fixture, so the block has
    // no trailing newline — the parser must not invent one.
    expect(result.files[0]?.content).toBe(
      "import { helper } from './utils/helper'\n\nexport const app = (): number => helper() + 1",
    )
    expect(result.files[1]?.content).toBe('export const helper = (): number => 41')
  })

  it('recovers from a malformed XML envelope via the File: contract', () => {
    const result = parseResponse(fixture('missing-close-tag.txt'))

    expect(result.strategy).toBe('markdown')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('src/app.ts')
    expect(result.files[0]?.pathSource).toBe('first-line-comment')
    expect(result.warnings.some((warning) => warning.includes('<file>'))).toBe(true)
  })

  it('resolves the File: header contract, including common drift', () => {
    const result = parseResponse(fixture('markdown-file-headers.txt'))

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/load_scanner_sim/scripts/truck_controller.py',
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'file-header')).toBe(true)
    expect(result.files[0]?.content).toBe(
      '#!/usr/bin/env python3\nimport rclpy\nfrom rclpy.node import Node',
    )
    // The reference tree is a fenced block too. It is a snippet, not a file,
    // so it is reported rather than silently dropped.
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('illustrative')
  })

  it('resolves paths from first-line comments', () => {
    const result = parseResponse(fixture('markdown-with-paths.txt'))

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'first-line-comment')).toBe(true)
  })

  it('resolves paths from backticked and bolded preceding text', () => {
    const result = parseResponse(fixture('mixed-conversational.txt'))

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'preceding-text')).toBe(true)
    expect(result.files[0]?.content).toBe('export const app = (): number => 42')
  })

  it('keeps both blocks whole when a fence nests inside a longer fence', () => {
    const result = parseResponse(fixture('nested-fences.txt'))

    expect(result.strategy).toBe('markdown')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('docs/README.md')
    expect(result.files[0]?.content).toContain('```bash\nnpm install\n```')
  })

  it('drops no code when nothing resolves a path', () => {
    const result = parseResponse(fixture('markdown-no-paths.txt'))

    expect(result.strategy).toBe('user-assisted')
    expect(result.files).toHaveLength(2)
    expect(result.files.every((file) => file.path === null && file.ambiguous)).toBe(true)
    expect(result.files[0]?.content).toBe(
      'export const app = (): number => 42\nexport const other = (): number => 43',
    )
    expect(result.warnings).toHaveLength(1)
  })

  it('normalizes windows separators', () => {
    const result = parseResponse(fixture('windows-paths.txt'))

    expect(result.strategy).toBe('xml')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
  })

  it('never throws on junk', () => {
    for (const input of ['', '   ', 'no code here', '<file>', '```']) {
      expect(() => parseResponse(input)).not.toThrow()
    }
    expect(parseResponse('').strategy).toBe('user-assisted')
    expect(parseResponse('').files).toEqual([])
  })

  it('keeps JSX inside an XML envelope intact', () => {
    const raw = [
      '<file path="src/App.tsx">',
      '',
      '```tsx',
      'export const App = () => <div className="x">hi</div>',
      '```',
      '',
      '</file>',
    ].join('\n')

    const result = parseResponse(raw)
    expect(result.strategy).toBe('xml')
    expect(result.files[0]?.content).toBe('export const App = () => <div className="x">hi</div>')
  })

  it('preserves CRLF line endings', () => {
    const raw =
      '<file path="src/app.ts">\r\n\r\n```typescript\r\nconst a = 1\r\nconst b = 2\r\n```\r\n\r\n</file>'

    const result = parseResponse(raw)
    // A real XML parser normalizes CRLF to LF on the way through; the body is
    // sliced out of the raw text precisely so a file's line endings survive.
    expect(result.files[0]?.content).toBe('const a = 1\r\nconst b = 2')
  })
})

describe('parseResponse — path safety', () => {
  it('rejects traversal and absolute paths from the envelope', () => {
    const raw = [
      '<file path="../../etc/passwd">',
      '',
      '```text',
      'root',
      '```',
      '',
      '</file>',
    ].join('\n')

    const result = parseResponse(raw)
    // The path is refused, so the block survives as ambiguous rather than
    // being written somewhere outside the project.
    expect(result.strategy).toBe('user-assisted')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBeNull()
    expect(result.files[0]?.content).toBe('root')
  })
})
