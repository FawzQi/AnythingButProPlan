import type { CodeBlock } from './types'

// `[^\r\n]*` rather than `.*`: `.` does not match a carriage return, so a CRLF
// response would never open a block.
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm

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

    blocks.push({
      language: info === '' ? null : (info.split(/\s+/)[0] ?? null),
      content,
      precedingText: before.slice(-3).join('\n'),
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