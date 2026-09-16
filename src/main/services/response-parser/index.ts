import type { ParseResult, ParsedFile } from '@shared/types'
import { extractCodeBlocks, extractPlainBlocks } from './markdown-parser'
import { resolvePath } from './path-heuristics'
import type { CodeBlock } from './types'

export type { CodeBlock } from './types'
export { extractCodeBlocks, extractPlainBlocks } from './markdown-parser'
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
 * The heading that starts the trailing explanation section. The output
 * contract guarantees every `File:` entry comes first and the Explanation /
 * Debug sections come last, so anything from this heading onward is prose
 * and illustrative commands — never a file change.
 *
 * Deliberately anchored at line start and to the exact `## Explanation`
 * heading the template prescribes, so a file body that happens to contain
 * the words "## Explanation" further down is the only way to trigger a
 * false cut — and that is not part of the contract's output shape.
 */
const EXPLANATION_HEADING = /^##[ \t]+Explanation[ \t]*\r?$/m

/**
 * Return only the part of the response that can contain file entries. When
 * the Explanation heading is present, the response is sliced at that point:
 * every code fence below it is illustrative (bash commands, examples) and
 * would otherwise be reported as a "skipped" block, which is misleading.
 *
 * When the heading is absent — e.g. a truncated or non-conforming response —
 * the whole string is returned untouched, preserving the previous behaviour.
 */
function filesSection(raw: string): string {
  const match = EXPLANATION_HEADING.exec(raw)
  return match ? raw.slice(0, match.index) : raw
}

/**
 * Parse a raw AI response into file changes.
 *
 * Runs the strategy cascade documented in CLAUDE.md and never throws: parse
 * failure degrades to user-assisted mapping rather than discarding code the
 * model produced.
 *
 * The cascade is two strategies plus a fallback:
 *   1. Markdown — a `File: <path>` header on the lines above a fenced block.
 *   2. Plaintext — the same header shape but no fences around the body.
 *   3. Fallback — every unresolved block reaches the UI for manual mapping.
 *
 * There is deliberately no XML envelope strategy. The legacy `<file>`
 * envelope was removed because its raw regex scan over the whole response
 * matched `<file>` sequences inside JavaScript string literals (the parser's
 * own warning messages, other codebases) and produced both false positives
 * and spurious warnings. The contract emitted by the prompt template is
 * markdown; supporting the two shapes above covers everything the app asks
 * a model to produce.
 */
export function parseResponse(raw: string): ParseResult {
  const warnings: string[] = []
  const scan = filesSection(raw)
  const blocks = extractCodeBlocks(scan)
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
    return {
      files: resolved.map((entry) => toParsedFile(entry.block, entry.hint.path, entry.hint.source, false)),
      strategy: 'markdown',
      warnings,
    }
  }

  // Strategy 2 — plaintext code blocks structured by File: paths without markdown fences
  const plainBlocks = extractPlainBlocks(scan)
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

  // Strategy 3 — hand everything to the user. Nothing resolved, so nothing is
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