import path from 'node:path'
import { BINARY_EXTENSIONS, readTextFile } from '../core/fs-service'

/**
 * Build a token-efficient skeleton of the codebase for the file-selection
 * query. The point is to fit as much *structure* as possible into a small
 * token budget: signatures, deps, and type definitions carry most of the
 * signal needed to answer "which files touch this feature?", and function
 * bodies carry almost none.
 *
 * Three tiers of detail, selected by extension:
 *   - Code: signatures, imports, exported type declarations, leading doc.
 *   - Config / data: a small preview (first N lines), since a config file's
 *     value is in its contents, not its shape.
 *   - Assets (images, video, fonts, binaries): path only. The AI gets enough
 *     to know the file exists and what it is named; it does not need the
 *     bytes, and reading a 200 MB video as UTF-8 to compute a line count is
 *     both slow and useless.
 */

export type FileKind = 'code' | 'config' | 'data' | 'doc' | 'asset'

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.vue', '.svelte', '.scala', '.dart', '.lua', '.sh', '.bash', '.zsh',
])

const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.conf', '.config', '.properties', '.editorconfig',
])

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.rst', '.txt', '.adoc'])

/**
 * Lock files and generated artefacts that would drown out real code in the
 * map. Not exhaustive — the point is to keep the common offenders out.
 */
const GENERATED_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'composer.lock',
  'gemfile.lock',
])

const MINIFIED = /\.min\.(?:js|css)$/i

export function classifyFile(filePath: string): FileKind {
  const name = path.basename(filePath)
  if (GENERATED_BASENAMES.has(name.toLowerCase())) return 'data'
  if (MINIFIED.test(name)) return 'asset'
  const ext = path.extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext) || ext === '.svg') return 'asset'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (CONFIG_EXTENSIONS.has(ext)) return 'config'
  if (DOC_EXTENSIONS.has(ext)) return 'doc'
  // Unknown extension: treat as config, which reads the file as text and
  // gives up quietly if it can't. This is safer than treating unknown files
  // as code and emitting nonsense signatures for them.
  return 'config'
}

/** Language family used to dispatch the skeleton extractor. */
type LanguageFamily =
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'ruby'
  | 'php'
  | 'shell'
  | 'other'

function languageFor(filePath: string): LanguageFamily {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.vue':
    case '.svelte':
      return 'typescript'
    case '.py':
      return 'python'
    case '.go':
      return 'go'
    case '.rs':
      return 'rust'
    case '.java':
    case '.kt':
    case '.scala':
      return 'java'
    case '.c':
    case '.h':
    case '.cpp':
    case '.hpp':
    case '.cc':
    case '.cs':
      return 'c'
    case '.rb':
      return 'ruby'
    case '.php':
      return 'php'
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell'
    default:
      return 'other'
  }
}

/**
 * The per-file skeleton. Each variant carries exactly the fields that are
 * meaningful for its `kind`:
 *
 *   - `asset`  — path only. Assets are never read as text.
 *   - `code`   — lines, imports, exported signatures.
 *   - `config | data | doc` — lines plus a small prose preview.
 *
 * The discriminated union replaces the previous optional-field soup
 * (`lines?`, `deps?`, `signatures?`, `preview?`), which permitted
 * contradictory states such as a `code` entry with only a `preview`.
 */
export type FileSkeleton =
  | { kind: 'asset'; path: string }
  | {
      kind: 'code'
      path: string
      lines: number
      deps: string[]
      signatures: string[]
    }
  | {
      kind: 'config' | 'data' | 'doc'
      path: string
      lines: number
      preview: string
    }

const PREVIEW_LINES = 25
const PREVIEW_MAX_CHARS = 800
const MAX_SIGNATURES = 40

function firstNLines(text: string, n: number, maxChars: number): string {
  const lines = text.split('\n').slice(0, n)
  let joined = lines.join('\n').trim()
  if (joined.length > maxChars) joined = joined.slice(0, maxChars) + ' …'
  return joined
}

/**
 * Take the declaration starting at `start` up to the first `{` or `;` or
 * `=>`, joining wrapped lines. The result is a compact one-line summary,
 * e.g. `export function scanDirectory(root: string): Promise<ScanResult>`.
 */
function takeSignature(text: string, start: number): string | null {
  let i = start
  let depth = 0
  while (i < text.length && i - start < 400) {
    const ch = text[i]
    if (ch === undefined) break
    if (ch === '(' || ch === '<' || ch === '[') depth++
    else if (ch === ')' || ch === '>' || ch === ']') depth--
    else if (depth === 0 && ch === '{') break
    else if (depth === 0 && ch === ';') { i += 1; break }
    else if (depth === 0 && ch === '=' && text[i + 1] === '>') {
      i += 2
      break
    }
    i += 1
  }
  const raw = text.slice(start, i)
  return raw.replace(/\s+/g, ' ').trim().replace(/\s*\{$/, '') || null
}

function extractTypeScript(text: string): { deps: string[]; signatures: string[] } {
  const deps = new Set<string>()
  const signatures: string[] = []

  for (const m of text.matchAll(/^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1]
    if (spec) deps.add(spec)
  }

  const exportRe =
    /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of text.matchAll(exportRe)) {
    const start = m.index ?? 0
    const sig = takeSignature(text, start)
    if (sig) signatures.push(sig)
    if (signatures.length >= MAX_SIGNATURES) break
  }

  return { deps: [...deps], signatures }
}

function extractPython(text: string): { deps: string[]; signatures: string[] } {
  const deps = new Set<string>()
  const signatures: string[] = []
  for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
    const spec = m[1] ?? m[2]
    if (spec) deps.add(spec)
  }
  for (const m of text.matchAll(/^(?:async\s+)?def\s+\w+\s*\([^)]*\)[^:]*:/gm)) {
    signatures.push(m[0].replace(/\s+/g, ' ').trim())
    if (signatures.length >= MAX_SIGNATURES) break
  }
  return { deps: [...deps], signatures }
}

function extractGo(text: string): { deps: string[]; signatures: string[] } {
  const deps = new Set<string>()
  const signatures: string[] = []
  const importBlock = /import\s*\(([\s\S]*?)\)/.exec(text)
  if (importBlock?.[1]) {
    for (const m of importBlock[1].matchAll(/"([^"]+)"/g)) {
      if (m[1]) deps.add(m[1])
    }
  }
  for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s+)?\w+\s*\([^)]*\)[^{]*/gm)) {
    signatures.push(m[0].replace(/\s+/g, ' ').trim())
    if (signatures.length >= MAX_SIGNATURES) break
  }
  return { deps: [...deps], signatures }
}

function extractGenericKeywords(
  text: string,
  keywords: RegExp,
): { deps: string[]; signatures: string[] } {
  const signatures: string[] = []
  for (const m of text.matchAll(keywords)) {
    signatures.push((m[0] ?? '').replace(/\s+/g, ' ').trim())
    if (signatures.length >= MAX_SIGNATURES) break
  }
  return { deps: [], signatures }
}

function extractCode(
  filePath: string,
  text: string,
): { deps: string[]; signatures: string[] } {
  const family = languageFor(filePath)
  switch (family) {
    case 'typescript':
      return extractTypeScript(text)
    case 'python':
      return extractPython(text)
    case 'go':
      return extractGo(text)
    case 'rust':
      return extractGenericKeywords(text, /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod)\s+\w+[^{;]*/gm)
    case 'java':
      return extractGenericKeywords(text, /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|enum|record)\s+\w+[^{]*|^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?[\w<>[\\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?/gm)
    case 'c':
      return extractGenericKeywords(text, /^(?:class|struct|enum|union)\s+\w+[^{;]*|^[\w:<>~*&\s]+\s+\w+\s*\([^;{]*\)\s*(?:const\s*)?[;{]/gm)
    case 'ruby':
      return extractGenericKeywords(text, /^\s*(?:def\s+\w+|class\s+\w+|module\s+\w+)[^\n]*/gm)
    case 'php':
      return extractGenericKeywords(text, /^\s*(?:public|private|protected|static|abstract|final|\s)*(?:function\s+\w+|class\s+\w+|interface\s+\w+|trait\s+\w+)[^\n{]*/gm)
    case 'shell':
      return extractGenericKeywords(text, /^\s*(?:function\s+)?\w+\s*\(\s*\)\s*\{[^\n]*|^\w+(?=\s*\(\))/gm)
    default:
      return { deps: [], signatures: [] }
  }
}

export async function skeletonFor(
  root: string,
  filePath: string,
): Promise<FileSkeleton | null> {
  const kind = classifyFile(filePath)

  // Assets are never read as text. Reading a PNG or a 500 MB video through
  // `fs.readFile(path, 'utf8')` produces either mojibake or a slow, memory-
  // hungry read that yields nothing useful — and the user asked explicitly
  // for asset files to appear as a path with no content. Return early so no
  // file handle is opened at all.
  if (kind === 'asset') {
    return { kind: 'asset', path: filePath }
  }

  let text: string
  try {
    text = await readTextFile(root, filePath)
  } catch {
    return null
  }
  const lines = text.split('\n').length

  if (kind === 'code') {
    const { deps, signatures } = extractCode(filePath, text)
    return { kind: 'code', path: filePath, lines, deps, signatures }
  }

  // config / data / doc
  return {
    kind,
    path: filePath,
    lines,
    preview: firstNLines(text, PREVIEW_LINES, PREVIEW_MAX_CHARS),
  }
}

function formatSkeleton(s: FileSkeleton): string {
  if (s.kind === 'asset') return `${s.path}  [asset]`

  if (s.kind === 'code') {
    const lines = [`${s.path}  [code, ${s.lines} lines]`]
    if (s.deps.length > 0) {
      lines.push(`  deps: ${s.deps.slice(0, 12).join(', ')}`)
    }
    if (s.signatures.length > 0) {
      for (const sig of s.signatures) lines.push(`  ${sig}`)
    } else {
      lines.push(`  (no exported symbols detected)`)
    }
    return lines.join('\n')
  }

  // config / data / doc
  const lines = [`${s.path}  [${s.kind}, ${s.lines} lines]`]
  lines.push('  ---')
  for (const ln of s.preview.split('\n')) lines.push(`  ${ln}`)
  return lines.join('\n')
}

export interface CodebaseMap {
  text: string
  /** Number of files that contributed to the map. */
  fileCount: number
}

/**
 * Build the skeleton map. Files are processed in parallel up to a small
 * concurrency limit — enough to hide I/O latency without opening thousands
 * of file handles at once on large repos.
 */
export async function buildCodebaseMap(
  root: string,
  filePaths: string[],
): Promise<CodebaseMap> {
  const skels: FileSkeleton[] = []
  const CONCURRENCY = 32
  let index = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = index++
      if (i >= filePaths.length) return
      const filePath = filePaths[i]
      if (filePath === undefined) continue
      const skel = await skeletonFor(root, filePath)
      if (skel) skels.push(skel)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, worker))
  skels.sort((a, b) => a.path.localeCompare(b.path))
  return {
    text: skels.map(formatSkeleton).join('\n\n'),
    fileCount: skels.length,
  }
}

/**
 * Build a bidirectional adjacency map of local file imports.
 * Given a list of relative repo file paths, resolves relative imports
 * (e.g. `./codebase-map`, `../types`) to other files in the repo.
 */
export async function buildImportGraph(
  root: string,
  filePaths: string[],
): Promise<Map<string, Set<string>>> {
  const fileSet = new Set(filePaths)
  const graph = new Map<string, Set<string>>()
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js']

  function addEdge(a: string, b: string) {
    let sA = graph.get(a)
    if (!sA) {
      sA = new Set()
      graph.set(a, sA)
    }
    sA.add(b)

    let sB = graph.get(b)
    if (!sB) {
      sB = new Set()
      graph.set(b, sB)
    }
    sB.add(a)
  }

  const CONCURRENCY = 32
  let index = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = index++
      if (i >= filePaths.length) return
      const filePath = filePaths[i]
      if (!filePath) continue
      const skel = await skeletonFor(root, filePath)
      if (!skel || skel.kind !== 'code' || !skel.deps) continue

      const dir = path.posix.dirname(filePath)
      for (const dep of skel.deps) {
        if (!dep.startsWith('.')) continue
        const resolved = path.posix.normalize(path.posix.join(dir, dep))
        for (const ext of extensions) {
          const candidate = resolved + ext
          if (fileSet.has(candidate)) {
            addEdge(filePath, candidate)
            break
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, worker))
  return graph
}