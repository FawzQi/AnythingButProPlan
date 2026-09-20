import { describe, expect, it } from 'vitest'
import { parseResponse } from '../../src/main/services/response-parser'

/**
 * Every test builds its response inline rather than loading a fixture. The
 * previous suite pulled `.txt` files from `tests/fixtures/responses/`, and
 * those fixtures were written in the XML envelope dialect that the parser no
 * longer understands — keeping them would have meant either rewriting every
 * fixture or watching every test fail. Inline strings make each test's input
 * visible next to the behaviour it asserts, and remove a directory of files
 * that only ever had one reader.
 */

function markdown(files: Array<{ path: string; language: string; body: string }>): string {
  return files
    .map(
      (file) =>
        `File: ${file.path}\n\n\`\`\`${file.language}\n${file.body}\n\`\`\``,
    )
    .join('\n\n')
}

describe('parseResponse — strategy cascade', () => {
  it('resolves the File: header contract, including common drift', () => {
    const raw = [
      'Some preamble the model added.',
      '',
      '## File: `src/app.ts`',
      '',
      '```typescript',
      "import { helper } from './utils/helper'",
      '',
      'export const app = (): number => helper() + 1',
      '```',
      '',
      '**File:** src/utils/helper.ts',
      '',
      '```typescript',
      'export const helper = (): number => 41',
      '```',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'file-header')).toBe(true)
    expect(result.files[0]?.content).toBe(
      "import { helper } from './utils/helper'\n\nexport const app = (): number => helper() + 1",
    )
    expect(result.files[1]?.content).toBe(
      'export const helper = (): number => 41',
    )
  })

  it('resolves paths from first-line comments', () => {
    const raw = markdown([
      {
        path: '',
        language: 'typescript',
        body: '// File: src/app.ts\nexport const app = (): number => 42',
      },
      {
        path: '',
        language: 'typescript',
        body: '// File: src/utils/helper.ts\nexport const helper = (): number => 41',
      },
    ])
      // Strip the empty `File: ` headers the helper would have emitted.
      .replace(/^File: \n\n/gm, '')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'first-line-comment')).toBe(true)
  })

  it('resolves paths from backticked and bolded preceding text', () => {
    const raw = [
      'Update `src/app.ts` to return 42:',
      '',
      '```typescript',
      'export const app = (): number => 42',
      '```',
      '',
      'Then touch **src/utils/helper.ts**:',
      '',
      '```typescript',
      'export const helper = (): number => 41',
      '```',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('markdown')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/utils/helper.ts',
    ])
    expect(result.files.every((file) => file.pathSource === 'preceding-text')).toBe(true)
    expect(result.files[0]?.content).toBe('export const app = (): number => 42')
  })

  it('keeps a nested fence inside a longer fence intact', () => {
    const raw = [
      'File: docs/README.md',
      '',
      '````markdown',
      'Install with:',
      '',
      '```bash',
      'npm install',
      '```',
      '````',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('markdown')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('docs/README.md')
    expect(result.files[0]?.content).toContain('```bash\nnpm install\n```')
  })

  it('drops no code when nothing resolves a path', () => {
    const raw = [
      'Here are some snippets:',
      '',
      '```typescript',
      'export const app = (): number => 42',
      'export const other = (): number => 43',
      '```',
      '',
      '```typescript',
      'export const third = (): number => 44',
      '```',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('user-assisted')
    expect(result.files).toHaveLength(2)
    expect(result.files.every((file) => file.path === null && file.ambiguous)).toBe(true)
    expect(result.files[0]?.content).toBe(
      'export const app = (): number => 42\nexport const other = (): number => 43',
    )
    expect(result.files[1]?.content).toBe('export const third = (): number => 44')
    expect(result.warnings).toHaveLength(1)
  })

  it('normalizes windows separators in File: headers', () => {
    const raw = [
      'File: src\\app.ts',
      '',
      '```typescript',
      'export const app = 1',
      '```',
      '',
      'File: src\\utils\\helper.ts',
      '',
      '```typescript',
      'export const helper = 2',
      '```',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('markdown')
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

  it('keeps JSX in a fenced block intact', () => {
    const raw = [
      'File: src/App.tsx',
      '',
      '```tsx',
      'export const App = () => <div className="x">hi</div>',
      '```',
    ].join('\n')

    const result = parseResponse(raw)
    expect(result.strategy).toBe('markdown')
    expect(result.files[0]?.content).toBe(
      'export const App = () => <div className="x">hi</div>',
    )
  })

  it('preserves CRLF line endings inside a fenced block', () => {
    const raw = [
      'File: src/app.ts',
      '',
      '```typescript',
      'const a = 1',
      'const b = 2',
      '```',
    ].join('\r\n')

    const result = parseResponse(raw)
    // The body is sliced out of the raw text by offset precisely so a file's
    // line endings survive; a split-and-rejoin would normalize them.
    expect(result.files[0]?.content).toBe('const a = 1\r\nconst b = 2')
  })
})

describe('parseResponse — patch dialect', () => {
  it('parses a pure patch response', () => {
    const raw = [
      'File: src/app.ts',
      '',
      '<<<<<<< SEARCH',
      'export const app = (): number => 41',
      '=======',
      'export const app = (): number => 42',
      '>>>>>>> REPLACE',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('patch')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('src/app.ts')
    expect(result.files[0]?.patches).toEqual([
      {
        search: 'export const app = (): number => 41',
        replace: 'export const app = (): number => 42',
      },
    ])
  })

  it('mixes full-content and patch sections in one response', () => {
    // The common case this guards: the model emits a brand-new file as a
    // fenced block and edits two existing files with SEARCH/REPLACE pairs.
    // Before the fix, the presence of any SEARCH marker committed the whole
    // response to the patch dialect and the new file was silently dropped.
    const raw = [
      'File: src/new-file.ts',
      '',
      '```typescript',
      'export const created = true',
      '```',
      '',
      'File: src/app.ts',
      '',
      '<<<<<<< SEARCH',
      'export const app = (): number => 41',
      '=======',
      'export const app = (): number => 42',
      '>>>>>>> REPLACE',
      '',
      'File: src/utils/helper.ts',
      '',
      '<<<<<<< SEARCH',
      'export const helper = (): number => 40',
      '=======',
      'export const helper = (): number => 41',
      '>>>>>>> REPLACE',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('patch')
    expect(result.files.map((file) => file.path)).toEqual([
      'src/new-file.ts',
      'src/app.ts',
      'src/utils/helper.ts',
    ])

    const [newFile, appEdit, helperEdit] = result.files
    expect(newFile?.content).toBe('export const created = true')
    expect(newFile?.patches).toBeUndefined()
    expect(appEdit?.patches).toHaveLength(1)
    expect(helperEdit?.patches).toHaveLength(1)
  })

  it('ignores a fenced block that lives inside a patch section', () => {
    // A SEARCH/REPLACE body can legitimately contain a fenced example. That
    // fence is part of the patch payload, not a standalone file, so it must
    // not produce a second entry.
    const raw = [
      'File: docs/README.md',
      '',
      '<<<<<<< SEARCH',
      'Run the installer:',
      '=======',
      'Run the installer:',
      '',
      '```bash',
      'npm install',
      '```',
      '>>>>>>> REPLACE',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.strategy).toBe('patch')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe('docs/README.md')
    expect(result.files[0]?.patches?.[0]?.replace).toContain('npm install')
  })
})

describe('parseResponse — deletes', () => {
  it('extracts Delete: directives alongside file entries', () => {
    const raw = [
      'Delete: src/old.ts',
      '',
      'File: src/app.ts',
      '',
      '```typescript',
      'export const app = 1',
      '```',
    ].join('\n')

    const result = parseResponse(raw)

    expect(result.files.map((file) => file.path)).toEqual([
      'src/old.ts',
      'src/app.ts',
    ])
    expect(result.files[0]?.delete).toBe(true)
    expect(result.files[0]?.pathSource).toBe('delete-header')
  })

  it('returns a delete-only response under its own strategy', () => {
    const result = parseResponse('Delete: src/old.ts\n')

    expect(result.strategy).toBe('delete')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.delete).toBe(true)
  })
})

describe('parseResponse — path safety', () => {
  it('rejects traversal paths, keeping the block for manual mapping', () => {
    const raw = [
      'File: ../../etc/passwd',
      '',
      '```text',
      'root',
      '```',
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