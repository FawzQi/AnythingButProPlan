import type { ParseResult, ParsedFile } from '@shared/types'
import { extractCodeBlocks, extractPlainBlocks } from './markdown-parser'
import { parseXmlEnvelope } from './xml-parser'
import { resolvePath } from './path-heuristics'
import type { CodeBlock } from './types'

export type { CodeBlock } from './types'
export { extractCodeBlocks, extractPlainBlocks } from './markdown-parser'
export { parseXmlEnvelope } from './xml-parser'
export { resolvePath, normalizePath } from './path-heuristics'

function toParsedFile(block: CodeBlock, path: string | null, source: ParsedFile['pathSource'], ambiguous: boolean): ParsedFile {
  return {
    path,
    content: block.content,
    language: block.language,
    pathSource: source,
    ambiguous,
    rawBlock: block.rawBlock,
  }
}

/**
 * Parse a raw AI response into file changes.
 *
 * Runs the strategy cascade documented in CLAUDE.md and never throws: parse
 * failure degrades to user-assisted mapping rather than discarding code the
 * model produced.
 */
export function parseResponse(raw: string): ParseResult {
  const warnings: string[] = []
  const blocks = extractCodeBlocks(raw)
  const hints = blocks.map((block) => ({ block, hint: resolvePath(block) }))
  const resolved = hints.filter((entry) => entry.hint.path !== null)

  // Strategy 1 — the output contract: `File: <path>` introducing each fence.
  // Any block that resolved marks the response as contract-shaped.
  if (resolved.length > 0) {
    const dropped = hints.length - resolved.length
    if (dropped > 0) {
      // Exactly the "do not silently skip" rule: a fenced block with no path
      // signal at all is illustrative prose (a tree, a shell one-liner), not a
      // file change. Say so rather than dropping it in silence.
      warnings.push(
        `${dropped} code block(s) carried no file path and were skipped as illustrative snippets.`,
      )
    }
    if (/<file\b/i.test(raw)) {
      warnings.push('Response mixed <file> tags with File: headers; the File: headers were used.')
    }
    return {
      files: resolved.map((entry) => toParsedFile(entry.block, entry.hint.path, entry.hint.source, false)),
      strategy: 'markdown',
      warnings,
    }
  }

  // Strategy 2 — legacy `<file path="...">` envelope, kept for responses that
  // still use it. Its bodies are raw-sliced, so line endings survive intact.
  const xmlBlocks = parseXmlEnvelope(raw)
  if (xmlBlocks.length > 0) {
    const usable: ParsedFile[] = []
    let rejected = 0
    for (const { path, block } of xmlBlocks) {
      const hint = resolvePath(block, { explicitPath: path })
      if (hint.path === null) {
        rejected += 1
        continue
      }
      usable.push(toParsedFile(block, hint.path, hint.source, false))
    }
    if (usable.length > 0) {
      if (rejected > 0) {
        warnings.push(
          `${rejected} <file> block(s) had a missing or unusable path attribute and were dropped.`,
        )
      }
      return { files: usable, strategy: 'xml', warnings }
    }
    warnings.push(
      `Found ${xmlBlocks.length} <file> block(s) but none carried a usable path attribute; falling back to user-assisted mapping.`,
    )
  } else if (/<file\b/i.test(raw)) {
    warnings.push(
      'Found <file> tags but the XML envelope is malformed (missing or unpaired </file>).',
    )
  }

  // Strategy 3 — plaintext code blocks structured by File: paths without markdown fences
  const plainBlocks = extractPlainBlocks(raw)
  if (plainBlocks.length > 0) {
    const usable: ParsedFile[] = []
    let rejected = 0
    for (const block of plainBlocks) {
      const hint = resolvePath(block)
      if (hint.path === null) {
        rejected += 1
        continue
      }
      usable.push(toParsedFile(block, hint.path, hint.source, false))
    }
    if (usable.length > 0) {
      if (rejected > 0) {
        warnings.push(`${rejected} plain text block(s) had a missing or unusable path and were dropped.`)
      }
      return { files: usable, strategy: 'plaintext', warnings }
    }
  }

  // Strategy 4 — hand everything to the user. Nothing resolved, so nothing is
  // dropped: every block reaches the UI for the user to place by hand.
  if (blocks.length === 0) {
    warnings.push('No fenced code blocks found in the response.')
    return { files: [], strategy: 'user-assisted', warnings }
  }
  warnings.push(
    `${blocks.length} code block(s) had no resolvable path and need a target file.`,
  )
  return {
    files: hints.map((entry) => toParsedFile(entry.block, null, entry.hint.source, true)),
    strategy: 'user-assisted',
    warnings,
  }
}