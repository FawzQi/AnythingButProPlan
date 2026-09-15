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
