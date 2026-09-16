import type { PathSource } from '@shared/types'
import type { CodeBlock, PathHint } from './types'

/** Language info-string -> plausible extension, for the language-hint rule only. */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  mjs: 'mjs',
  cjs: 'cjs',
  py: 'py',
  python: 'py',
  rb: 'rb',
  ruby: 'rb',
  go: 'go',
  rs: 'rs',
  rust: 'rs',
  java: 'java',
  kt: 'kt',
  swift: 'swift',
  php: 'php',
  cs: 'cs',
  c: 'c',
  cpp: 'cpp',
  h: 'h',
  hpp: 'hpp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  md: 'md',
  markdown: 'md',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  sql: 'sql',
  xml: 'xml',
  ini: 'ini',
  env: 'env',
}

/** `// File: src/app.ts` / `# src/app.ts` / `<!-- src/app.ts -->` */
const FIRST_LINE_COMMENT =
  /^\s*(?:\/\/|#|<!--)\s*(?:File:)?\s*(.+?\.\w+)\s*(?:-->)?\s*$/

/**
 * The output contract: a `File: <path>` line introducing the fenced block.
 * Tolerates the drift models actually produce — `## File: x`, `**File:** x`,
 * a backticked path, or a trailing colon inside the marks.
 */
const FILE_HEADER = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*File\s*:\s*(.+?)\s*$/i

const BACKTICK_PATH = /`([^`\n]*?\.[A-Za-z0-9]{1,12})`/
const BOLD_PATH = /\*\*([^*\n]*?\.[A-Za-z0-9]{1,12})\*\*/
const SINGLE_FILE_HINT = /\b(the file|this file|the following file)\b/i

/**
 * Normalize a candidate to a POSIX-relative path, or null if it cannot be one.
 * Windows separators are folded to `/` here so `src\app.ts` and `src/app.ts`
 * compare equal everywhere downstream.
 */
export function normalizePath(raw: string): string | null {
  let candidate = raw.trim().replace(/\\/g, '/')

  // Heuristic text often wraps the path in prose ("update src/app.ts now").
  // Take the last token that actually looks like a path rather than the last
  // token outright, so trailing words do not swallow the match.
  // ponytail: token scan, revisit if users report space-bearing filenames.
  const tokens = candidate.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) {
    const looksLikePath = [...tokens].reverse().find((token) => /\.[A-Za-z0-9]{1,8}$/.test(token))
    if (!looksLikePath) return null
    candidate = looksLikePath
  }

  candidate = candidate.replace(/^\.\//, '').replace(/^\/+/, '').replace(/^"|"$/g, '')

  if (candidate === '' || candidate.length > 512) return null
  if (candidate.includes('..')) return null
  if (candidate.includes('\0')) return null
  if (!/^[\w.@+-][\w./@+ -]*$/.test(candidate)) return null

  // Must look like a filename rather than a bare word: a dot that is not the
  // last character. This keeps dotfiles such as `.gitignore` while rejecting
  // prose like "now" or a trailing "sentence."
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1)
  if (!basename.includes('.') || basename.endsWith('.')) return null

  return candidate
}

/** First non-empty line of the block, or null. */
function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split('\n')) {
    if (line.trim() !== '') return line
  }
  return null
}

/**
 * Scan the lines above a fence for a `File: <path>` header, closest line
 * first. The window can therefore be made larger without the risk of
 * attributing an earlier block's header to this one: the nearest header
 * always wins.
 *
 * The window is scanned line by line rather than with a single regex, since
 * models often slip a blank line or a sentence between the header and the
 * fence.
 */
function pathFromFileHeader(text: string): string | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === undefined) continue
    const match = FILE_HEADER.exec(line)
    if (!match?.[1]) continue
    // `**File:** \`src/app.ts\`` is common drift; strip the emphasis marks
    // wherever they landed rather than only at the edges. Asterisks and
    // backticks are not legal in a path on any platform we write to.
    const cleaned = match[1].replace(/[`*]/g, '').trim()
    const normalized = normalizePath(cleaned)
    if (normalized) return normalized
  }
  return null
}

function pathFromText(text: string): string | null {
  const backtick = BACKTICK_PATH.exec(text)
  if (backtick?.[1]) {
    const normalized = normalizePath(backtick[1])
    if (normalized) return normalized
  }
  const bold = BOLD_PATH.exec(text)
  if (bold?.[1]) {
    const normalized = normalizePath(bold[1])
    if (normalized) return normalized
  }
  return null
}

export interface ResolveOptions {
  /** Path from the XML `path` attribute, when the block came from an envelope. */
  explicitPath?: string | null
  source?: PathSource
}

/**
 * Resolve a code block to a target path. Precedence is exactly the order
 * documented in CLAUDE.md; the first rule that produces a usable path wins.
 * Never throws — an unresolved block comes back `ambiguous: true` so the UI can
 * ask the user instead of dropping the AI's code on the floor.
 */
export function resolvePath(block: CodeBlock, options: ResolveOptions = {}): PathHint {
  if (options.explicitPath != null) {
    const normalized = normalizePath(options.explicitPath)
    if (normalized) {
      return { path: normalized, source: options.source ?? 'xml', ambiguous: false }
    }
  }

  // The output contract: `File: <path>` introducing the fence.
  const fromHeader = pathFromFileHeader(block.precedingText)
  if (fromHeader) {
    return { path: fromHeader, source: 'file-header', ambiguous: false }
  }

  const line = firstNonEmptyLine(block.content)
  if (line) {
    const match = FIRST_LINE_COMMENT.exec(line)
    if (match?.[1]) {
      const normalized = normalizePath(match[1])
      if (normalized) {
        return { path: normalized, source: 'first-line-comment', ambiguous: false }
      }
    }
  }

  const fromPreceding = pathFromText(block.precedingText)
  if (fromPreceding) {
    return { path: fromPreceding, source: 'preceding-text', ambiguous: false }
  }

  const language = block.language?.toLowerCase() ?? null
  const extension = language ? LANGUAGE_EXTENSIONS[language] : undefined
  if (extension && SINGLE_FILE_HINT.test(block.precedingText)) {
    // We can guess the language but not the name. Force user confirmation.
    return { path: null, source: 'language-hint', ambiguous: true }
  }

  return { path: null, source: 'language-hint', ambiguous: true }
}
