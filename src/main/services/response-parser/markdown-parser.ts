import type { PatchBlock } from '@shared/types'
import type { CodeBlock } from './types'

// `[^\r\n]*` rather than `.*`: `.` does not match a carriage return, so a CRLF
// response would never open a block.
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm

/**
 * How many lines above an opening fence are scanned for a `File:` header.
 *
 * Sized to cover the output contract's own formatting (header line, blank
 * line, fence) plus a couple of blank lines of drift the model sometimes
 * adds. The window is intentionally not larger: `pathFromFileHeader` scans
 * it closest-first, so a larger window cannot attribute a previous block's
 * header to this one, but keeping it bounded keeps the read cheap.
 */
const PRECEDING_WINDOW = 6

/**
 * Markers for the patch dialect. Aider's SEARCH/REPLACE uses 7+ of each
 * character, followed by the keyword, on a line by itself. Leading whitespace
 * is deliberately not tolerated — the whole point of anchoring to column 0 is
 * that the markers cannot be confused with content inside the code.
 */
const SEARCH_OPEN = /^<{7,}\s*SEARCH\s*$/i
const SEARCH_SEP = /^={7,}\s*$/
const SEARCH_CLOSE = /^>{7,}\s*REPLACE\s*$/i

/**
 * Pull fenced code blocks out of a raw response with a line-based state machine.
 *
 * Deliberately NOT a markdown parser: we need raw content and exact fence
 * positions, and `marked` normalizes both. Fence length is tracked so a ````
 * block containing ``` fences (docs about markdown, nested examples) closes at
 * the right place instead of ending early on the inner fence.
 *
 * Content is sliced out of the raw string by offset rather than split and
 * rejoined, so CRLF survives and a file round-trips byte-for-byte. One line
 * terminator before the closing fence is treated as the fence's own separator
 * and is not part of the content, matching how the prompt template formats a
 * file body.
 *
 * An unterminated fence runs to end of input — truncated LLM output still
 * yields a usable block rather than nothing.
 */
export function extractCodeBlocks(raw: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const opener = new RegExp(OPENING_FENCE.source, 'gm')

  let opening = opener.exec(raw)
  while (opening) {
    const fence = opening[1] ?? ''
    const marker = fence[0] ?? '`'
    const info = (opening[2] ?? '').trim()
    const lineStart = opening.index

    const newlineIndex = raw.indexOf('\n', lineStart + opening[0].length)
    const contentStart = newlineIndex === -1 ? raw.length : newlineIndex + 1

    const closerPattern = new RegExp(
      `^ {0,3}\\${marker}{${fence.length},}[ \\t]*\\r?$`,
      'gm',
    )
    closerPattern.lastIndex = contentStart
    const closing = closerPattern.exec(raw)

    const contentEnd = closing ? closing.index : raw.length
    const blockEnd = closing ? closing.index + closing[0].length : raw.length
    const content = stripOneTerminator(raw.slice(contentStart, contentEnd))

    const before = raw.slice(0, lineStart).split(/\r?\n/)
    if (before[before.length - 1] === '') before.pop()

    // `(typescript)` is drift some models emit for the info string; strip a
    // balanced or unbalanced pair of parentheses so the language hint matches
    // the LANGUAGE_EXTENSIONS table just like a bare `typescript` would.
    const rawLanguage = info === '' ? null : (info.split(/\s+/)[0] ?? null)
    const language = rawLanguage === null ? null : rawLanguage.replace(/^\(+/, '').replace(/\)+$/, '') || null

    blocks.push({
      language,
      content,
      precedingText: before.slice(-PRECEDING_WINDOW).join('\n'),
      rawBlock: raw.slice(lineStart, blockEnd),
      startLine: countNewlines(raw, lineStart) + 1,
    })

    // Resume past this block so fences inside it are not re-scanned.
    opener.lastIndex = blockEnd
    opening = opener.exec(raw)
  }

  return blocks
}

/**
 * Extract code blocks from a plaintext format with no markdown fences, modeled on:
 * 
 * File: (file path)
 * 
 * (language)
 * 
 * (full code)
 */
export function extractPlainBlocks(raw: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const headerPattern = /^\s*File:\s*(.+?)\s*$/gm

  let match = headerPattern.exec(raw)
  while (match) {
    const lineStart = match.index
    const path = match[1]
    const contentStart = lineStart + match[0].length

    headerPattern.lastIndex = contentStart
    const nextMatch = headerPattern.exec(raw)
    const nextIndex = nextMatch ? nextMatch.index : raw.length
    if (nextMatch) {
      headerPattern.lastIndex = nextMatch.index
    }

    const chunk = raw.slice(contentStart, nextIndex)
    const lines = chunk.split(/\r?\n/)
    
    let language: string | null = null
    let codeStartIdx = 0
    
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '') continue
      // Check if this line looks like a language declaration
      const langMatch = /^\(?([a-zA-Z0-9_+#-]+)\)?$/.exec(trimmed)
      if (langMatch) {
        language = langMatch[1]
        codeStartIdx = i + 1
      } else {
        codeStartIdx = i
      }
      break
    }
    
    // Trim blank lines at the top of the code
    while (codeStartIdx < lines.length && lines[codeStartIdx].trim() === '') {
      codeStartIdx++
    }
    
    // Trim blank lines at the bottom of the code
    let codeEndIdx = lines.length
    while (codeEndIdx > codeStartIdx && lines[codeEndIdx - 1].trim() === '') {
      codeEndIdx--
    }
    
    const contentLines = lines.slice(codeStartIdx, codeEndIdx)
    const content = contentLines.join('\n') + (contentLines.length > 0 ? '\n' : '')

    blocks.push({
      language,
      content,
      precedingText: `File: ${path}`,
      rawBlock: raw.slice(lineStart, nextIndex),
      startLine: countNewlines(raw, lineStart) + 1,
    })
    
    match = nextMatch
  }

  return blocks
}

/**
 * A `File: <path>` section that carried one or more SEARCH/REPLACE pairs.
 * `rawBlock` is the original text of the section, so the UI can show exactly
 * what the model wrote.
 */
export interface PatchSection {
  path: string
  patches: PatchBlock[]
  rawBlock: string
}

/**
 * Pull `File: <path>` sections that contain SEARCH/REPLACE pairs out of a raw
 * response. This is the "patch" dialect of the output contract: an existing
 * file is edited by quoting the exact substring to replace rather than
 * restating the whole file.
 *
 * Sections without a well-formed pair are skipped, leaving them for the
 * full-content strategies. The parser never mixes patch and full content for
 * the same file — if a section has any pairs at all, all of its body is
 * consumed as pairs.
 */
export function extractSearchReplaceSections(raw: string): PatchSection[] {
  const sections: PatchSection[] = []
  const headerPattern = /^\s*File:\s*(.+?)\s*$/gm

  let match = headerPattern.exec(raw)
  while (match) {
    const path = match[1] ?? ''
    const sectionStart = match.index
    const contentStart = sectionStart + match[0].length

    headerPattern.lastIndex = contentStart
    const nextMatch = headerPattern.exec(raw)
    const sectionEnd = nextMatch ? nextMatch.index : raw.length
    if (nextMatch) headerPattern.lastIndex = nextMatch.index

    const body = raw.slice(contentStart, sectionEnd)
    const patches = parsePatchPairs(body)
    if (patches.length > 0) {
      sections.push({
        path,
        patches,
        rawBlock: raw.slice(sectionStart, sectionEnd),
      })
    }

    match = nextMatch
  }

  return sections
}

/**
 * Line-based state machine over a `File:` section body. Only lines consisting
 * solely of the marker shapes are honoured as boundaries, so a stray `=======`
 * inside the search or replace content cannot end a pair early.
 */
function parsePatchPairs(body: string): PatchBlock[] {
  const lines = body.split(/\r?\n/)
  const pairs: PatchBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!SEARCH_OPEN.test(line)) {
      index += 1
      continue
    }

    let separator = index + 1
    while (separator < lines.length && !SEARCH_SEP.test(lines[separator] ?? '')) {
      separator += 1
    }
    if (separator >= lines.length) break

    let close = separator + 1
    while (close < lines.length && !SEARCH_CLOSE.test(lines[close] ?? '')) {
      close += 1
    }
    if (close >= lines.length) break

    const search = lines.slice(index + 1, separator).join('\n')
    const replace = lines.slice(separator + 1, close).join('\n')
    // An empty search would match the start of the file, which is never what
    // the model means. Reject the pair rather than splice at position 0.
    if (search.length > 0) pairs.push({ search, replace })
    index = close + 1
  }

  return pairs
}

/**
 * Pull `Delete: <path>` directives out of a response. The line must sit in
 * the prose between fenced blocks — a code body that legitimately contains
 * `Delete: something` (a migration script, an ORM model) must not be mistaken
 * for a directive, so fenced regions are stripped before scanning.
 *
 * The check is deliberately loose about where the line sits: the output
 * contract allows the AI to interleave deletes with file entries in any
 * order, and the marker itself is unambiguous, so no further structural
 * parsing is needed.
 */
export function extractDeletePaths(raw: string): string[] {
  const stripped = stripFencedRegions(raw)
  const paths: string[] = []
  const pattern = /^\s*Delete:\s*(.+?)\s*$/gim
  let match = pattern.exec(stripped)
  while (match) {
    const path = (match[1] ?? '').trim()
    if (path !== '') paths.push(path)
    match = pattern.exec(stripped)
  }
  return paths
}

/**
 * Replace every fenced code block in `raw` with the same number of newlines,
 * preserving line structure for the rest of the scan. Offsets of the prose
 * between blocks are also preserved, so a caller could splice the result
 * back into `raw` if it ever needed to.
 */
function stripFencedRegions(raw: string): string {
  const blocks = extractCodeBlocks(raw)
  if (blocks.length === 0) return raw
  const parts: string[] = []
  let cursor = 0
  for (const block of blocks) {
    const start = raw.indexOf(block.rawBlock, cursor)
    if (start === -1) continue
    parts.push(raw.slice(cursor, start))
    const newlineCount = (block.rawBlock.match(/\n/g) ?? []).length
    parts.push('\n'.repeat(newlineCount))
    cursor = start + block.rawBlock.length
  }
  parts.push(raw.slice(cursor))
  return parts.join('')
}

/** Drop the single line terminator that separates content from the closing fence. */
function stripOneTerminator(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

function countNewlines(raw: string, upTo: number): number {
  let count = 0
  for (let index = 0; index < upTo; index += 1) {
    if (raw.charCodeAt(index) === 10) count += 1
  }
  return count
}