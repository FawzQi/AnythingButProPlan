import type { ParsedFile, ParseResult, PatchBlock } from '@shared/types'
import {
  extractCodeBlocks,
  extractDeletePaths,
  extractPlainBlocks,
  extractSearchReplaceSections,
} from './markdown-parser'
import { normalizePath, resolvePath } from './path-heuristics'
import type { CodeBlock } from './types'

export type { CodeBlock } from './types'
export {
  extractCodeBlocks,
  extractDeletePaths,
  extractPlainBlocks,
  extractSearchReplaceSections,
} from './markdown-parser'
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
 */
const EXPLANATION_HEADING = /^##[ \t]+Explanation[ \t]*\r?$/m

/**
 * Return only the part of the response that can contain file entries. When
 * the Explanation heading is present, the response is sliced at that point:
 * every code fence below it is illustrative (bash commands, examples) and
 * would otherwise be reported as a "skipped" block, which is misleading.
 *
 * When the heading is absent — e.g. a truncated or non-conforming response —
 * the whole string is returned untouched.
 */
function filesSection(raw: string): string {
  const match = EXPLANATION_HEADING.exec(raw)
  return match ? raw.slice(0, match.index) : raw
}

/**
 * Any `<<<<<<< SEARCH` marker on a line by itself switches the whole response
 * into the patch dialect. The prompt asks for one shape or the other, not a
 * mix, so this is a whole-response decision rather than a per-file one.
 */
const HAS_PATCH_MARKERS = /^<{7,}\s*SEARCH\s*$/im

/**
 * Render the patch pairs back into Aider-style blocks. Only used for display
 * — the file's real "content" in the UI — since the applier consumes the
 * `patches` array directly. Round-tripping through this representation keeps
 * the ResponsePanel's diff viewer from showing garbage.
 */
function renderPatches(patches: PatchBlock[]): string {
  return patches
    .map((patch) => `<<<<<<< SEARCH\n${patch.search}\n=======\n${patch.replace}\n>>>>>>> REPLACE`)
    .join('\n\n')
}

/**
 * Parse a raw AI response into file changes.
 *
 * Runs the strategy cascade documented in CLAUDE.md and never throws: parse
 * failure degrades to user-assisted mapping rather than discarding code the
 * model produced.
 *
 * The cascade is three strategies plus a fallback:
 *   1. Patch — `File: <path>` sections containing SEARCH/REPLACE pairs.
 *   2. Markdown — a `File: <path>` header on the lines above a fenced block.
 *   3. Plaintext — the same header shape but no fences around the body.
 *   4. Fallback — every unresolved block reaches the UI for manual mapping.
 *
 * Patch wins over markdown when both are present, because a response that
 * contains SEARCH markers is using the patch dialect for every file it edits;
 * a fenced block that happens to appear is either a new file the model chose
 * to emit whole, or (unlikely) an example. Preferring the patch reading keeps
 * the common case cheap.
 */
export function parseResponse(raw: string): ParseResult {
  const warnings: string[] = []
  const scan = filesSection(raw)

  // Deletes can appear alongside any of the file-entry shapes — the output
  // contract lets the AI interleave `Delete:` lines with `File:` entries in
  // any order. They are extracted up front and merged into whichever branch
  // produces the file list, so a response that deletes one file and edits
  // another comes back as a single coherent set of entries.
  const deleteEntries: ParsedFile[] = extractDeletePaths(scan)
    .map((candidate) => normalizePath(candidate))
    .filter((path): path is string => path !== null)
    .map((path) => ({
      path,
      content: '',
      language: null,
      pathSource: 'delete-header',
      ambiguous: false,
      rawBlock: `Delete: ${path}`,
      delete: true,
    }))

  if (HAS_PATCH_MARKERS.test(scan)) {
    const sections = extractSearchReplaceSections(scan)
    const usable: ParsedFile[] = []
    let rejected = 0
    for (const section of sections) {
      const normalized = normalizePath(section.path)
      if (!normalized) {
        rejected += 1
        continue
      }
      usable.push({
        path: normalized,
        content: renderPatches(section.patches),
        language: null,
        pathSource: 'file-header',
        ambiguous: false,
        rawBlock: section.rawBlock,
        patches: section.patches,
      })
    }
    if (usable.length > 0) {
      if (rejected > 0) {
        warnings.push(
          `${rejected} patch section(s) had a missing or unusable path and were dropped.`,
        )
      }
      return { files: [...deleteEntries, ...usable], strategy: 'patch', warnings }
    }
    // Nothing usable in the patch dialect; fall through so a malformed
    // response still gets a chance through the fence-based strategies. The
    // delete entries, if any, stay in the pipeline.
    if (deleteEntries.length === 0) {
      warnings.push(
        'Found SEARCH/REPLACE markers but no section carried a usable path; falling back to full-content parsing.',
      )
    }
  }

  const blocks = extractCodeBlocks(scan)
  const hints = blocks.map((block) => ({ block, hint: resolvePath(block) }))
  const resolved = hints.filter((entry) => entry.hint.path !== null)

  // Strategy 2 — the output contract: `File: <path>` introducing each fence.
  if (resolved.length > 0) {
    const dropped = hints.length - resolved.length
    if (dropped > 0) {
      warnings.push(
        `${dropped} code block(s) carried no file path and were skipped as illustrative snippets.`,
      )
    }
    return {
      files: [
        ...deleteEntries,
        ...resolved.map((entry) => toParsedFile(entry.block, entry.hint.path, entry.hint.source, false)),
      ],
      strategy: 'markdown',
      warnings,
    }
  }

  // Strategy 3 — plaintext code blocks structured by File: paths without markdown fences
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
      return { files: [...deleteEntries, ...usable], strategy: 'plaintext', warnings }
    }
  }

  // A response that contains only deletes is a legitimate result: the user
  // asked for cleanup and the model produced nothing but the list. Return it
  // under its own strategy so the UI can label it clearly.
  if (deleteEntries.length > 0) {
    return { files: deleteEntries, strategy: 'delete', warnings }
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