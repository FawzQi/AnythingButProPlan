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

/**
 * Build a `ParsedFile` from a code block and the path the heuristics found
 * for it. A null path means the block reaches the UI for manual mapping
 * (`kind: 'unresolved'`); anything else is a full-content entry.
 */
function toParsedFile(
  block: CodeBlock,
  path: string | null,
  source: ParsedFile['pathSource'],
): ParsedFile {
  const common = {
    rawBlock: block.rawBlock,
    language: block.language,
    pathSource: source,
    content: block.content,
  }
  if (path === null) {
    return { ...common, kind: 'unresolved' as const, path: null }
  }
  return { ...common, kind: 'full' as const, path }
}

/**
 * The headings and delimited markers that start the trailing prose
 * sections. The output contract guarantees every `File:` entry comes first
 * and the Explanation / Debug sections come last, so anything from either
 * marker onward is prose and illustrative commands — never a file change.
 *
 * Both sections are matched, not just Explanation, because a non-conforming
 * response can omit Explanation but still include Debug. Slicing at
 * Explanation alone would then leave the Debug body in the scan, and any
 * code fence there with a `File:`-shaped line above it would be mistaken
 * for a real file entry — the exact failure mode where a shell command or
 * example snippet is written to disk because it happens to sit under a path.
 *
 * Two dialects are recognised, because the output contract has changed
 * shape and old responses (and old habits in a model's training data) may
 * still arrive in the previous form:
 *
 *   - the markdown-heading dialect — `## Explanation`, `### Part 3: Debug`,
 *     `## 2. Explanation` — where the keyword sits anywhere in a line of
 *     two to six `#` characters, and bold/italic markers, a trailing
 *     colon, and any surrounding prose are absorbed by the trailing
 *     `[^\r\n]*`; and
 *
 *   - the delimited dialect the prompt now emits — `===Explanation===`,
 *     `===Debug===` — where the line consists of two or more `=` on each
 *     side of the keyword and nothing but whitespace around it.
 *
 * The keyword may sit anywhere in the markdown heading, not just at the
 * start. Models routinely prefix it with a section number or a title —
 * `### Section 2 — Explanation`, `#### Part 3: Debug`, `## 2. Explanation`
 * are all shapes that have been observed. Anchoring the keyword to the
 * start of the heading, which is what an earlier version of this regex did,
 * silently missed every one of them: the file entries above the missed
 * heading were still parsed, but the fenced blocks *below* it — shell
 * commands in the Debug section, illustrative snippets in Explanation —
 * were scanned as if they were real file bodies and surfaced as
 * "skipped" warnings, or worse, written to disk if a `File:`-shaped line
 * happened to sit above them.
 *
 * Matching is case-insensitive in both dialects. The constraints that
 * remain are deliberate:
 *
 *   - At least two `#` / at least two `=`. Shell, Python, Ruby, and YAML
 *     all use `#` for line comments, and a file body containing
 *     `# Explanation of the algorithm` would otherwise be sliced off
 *     mid-file, truncating the very content the parser was scanning for.
 *     A single `=` is a YAML mapping separator, so the delimited branch
 *     requires at least two.
 *
 *   - The keyword must be a whole word. `Debugging` and `Explanations`
 *     do not match, so a heading like `## Debugging tips` inside a file
 *     body is not mistaken for the terminal section.
 *
 *   - In the delimited dialect, only whitespace may follow the closing
 *     `=`. A body line such as `===Explanation of the algorithm===` is a
 *     sentence, not a section header, and must not end the file-entry
 *     scan early.
 */
const TERMINAL_HEADING =
  /^[ \t]*(?:#{2,6}[^\r\n]*\b(?:Explanation|Debug)\b[^\r\n]*|={2,}\s*(?:Explanation|Debug)\s*={2,}[ \t]*)$/im

/**
 * Opening marker of the delimited file-entry section the output contract
 * now emits. Matches a line of the shape `===Files===` — two or more `=`
 * on each side of the keyword, nothing but whitespace around it, any case —
 * but only at the very start of the response (after optional leading blank
 * lines). The matching terminator is `SECTION_CLOSE` below.
 *
 * Deliberately no `m` flag: a `===Files===` line anywhere in the response
 * is almost always part of the output instructions the prompt itself
 * carries. The prompt is a legitimate input — a user can paste it back
 * into the response box — and echoing it produces a `===Files===` line
 * inside the prompt's own prose. Treating that line as the opener sliced
 * away every real file entry above it, which is how the round-trip test
 * failed. A response that has lost its opener still works through the
 * terminal-heading fallback below.
 */
const FILES_SECTION_OPEN = /^[ \t]*={2,}\s*Files\s*={2,}[ \t]*(?:\r?\n|$)/i

/**
 * Terminator of a delimited section. Deliberately exact: six `=` on a line
 * by itself (with optional surrounding whitespace), not seven or more.
 * `=======` (7+) is the SEARCH/REPLACE separator used inside a file body,
 * and treating it as the end of the enclosing section would silently
 * truncate every patch that followed it. Six is also the floor because a
 * stray `=====` in ordinary prose is more likely a horizontal rule than a
 * section terminator, and the output contract is explicit about the count.
 */
const SECTION_CLOSE = /^[ \t]*={6}[ \t]*$/m

/**
 * Return only the part of the response that can contain file entries.
 *
 * The delimited dialect the prompt now emits opens with `===Files===` and
 * closes with `======`. When both markers are present, the body between
 * them is returned: the markers themselves are dropped, so a plaintext-mode
 * fallback cannot swallow the closing `======` line as if it were file
 * content, and the Explanation / Debug sections cannot leak into the scan.
 *
 * When the delimited opening is missing — a truncated response, or one
 * still using the previous markdown-heading contract — the response is
 * sliced at the first `## Explanation` / `## Debug` / `===Explanation===`
 * / `===Debug===` heading instead. Both dialects are matched by
 * `TERMINAL_HEADING`.
 *
 * When neither marker is present, the whole string is returned untouched,
 * preserving the existing degraded-mode behavior.
 */
function filesSection(raw: string): string {
  // Strip leading blank lines so a response that opens with whitespace still
  // matches the opener anchored at the start of the string.
  const trimmed = raw.replace(/^(?:[ \t]*\r?\n)*/, '')

  const open = FILES_SECTION_OPEN.exec(trimmed)
  if (open && open.index === 0) {
    const rest = trimmed.slice(open[0].length)
    const close = SECTION_CLOSE.exec(rest)
    if (close) return rest.slice(0, close.index)
    // No close found. Fall through to the heading-based slice below, which
    // will catch `===Explanation===` / `===Debug===` if the model emitted
    // them, and otherwise returns the whole string.
  }

  const match = TERMINAL_HEADING.exec(raw)
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
    .map(
      (path): ParsedFile => ({
        kind: 'delete',
        path,
        content: '',
        language: null,
        pathSource: 'delete-header',
        rawBlock: `Delete: ${path}`,
      }),
    )

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
        kind: 'patch',
        path: normalized,
        content: renderPatches(section.patches),
        language: null,
        pathSource: 'file-header',
        rawBlock: section.rawBlock,
        patches: section.patches,
      })
    }

    // A response can legitimately mix patch sections with full-content
    // sections — e.g. a brand-new file emitted whole, plus SEARCH/REPLACE
    // edits to two existing files. The patch pass above only captures the
    // edit sections, so also run the fenced-block pass and keep the blocks
    // that are not inside a patch section. Without this, every full-content
    // entry in a mixed response is silently dropped, because the markdown
    // strategy is never reached once any SEARCH marker is present.
    //
    // Both scans are positional: `extractSearchReplaceSections` returns
    // sections in source order and `extractCodeBlocks` returns blocks in
    // source order, so a running cursor finds each raw slice at its real
    // offset even when two sections carry identical text.
    const patchRanges: Array<{ start: number; end: number }> = []
    let sectionCursor = 0
    for (const section of sections) {
      const start = scan.indexOf(section.rawBlock, sectionCursor)
      if (start === -1) continue
      sectionCursor = start + section.rawBlock.length
      patchRanges.push({ start, end: sectionCursor })
    }

    const fullContentFiles: ParsedFile[] = []
    let blockCursor = 0
    for (const block of extractCodeBlocks(scan)) {
      const blockStart = scan.indexOf(block.rawBlock, blockCursor)
      if (blockStart === -1) continue
      blockCursor = blockStart + block.rawBlock.length
      // A fenced block that sits inside a patch section is part of the
      // SEARCH/REPLACE body (an example embedded in the search or replace
      // text), not a full file. The patch entry above already covers it.
      const insidePatch = patchRanges.some(
        (range) => blockStart >= range.start && blockStart < range.end,
      )
      if (insidePatch) continue
      const hint = resolvePath(block)
      if (hint.path === null) continue
      fullContentFiles.push(toParsedFile(block, hint.path, hint.source))
    }

    if (usable.length > 0 || fullContentFiles.length > 0) {
      if (rejected > 0) {
        warnings.push(
          `${rejected} patch section(s) had a missing or unusable path and were dropped.`,
        )
      }
      // `patch` labels the response when any patch entry is present, even
      // though it may also carry full-content entries. When only the
      // full-content half resolved — a stray SEARCH marker somewhere in
      // the prose, but no real patch sections — the response is a
      // markdown result in everything but name.
      return {
        files: [...deleteEntries, ...fullContentFiles, ...usable],
        strategy: usable.length > 0 ? 'patch' : 'markdown',
        warnings,
      }
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
        ...resolved.map((entry) =>
          toParsedFile(entry.block, entry.hint.path, entry.hint.source),
        ),
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
      usable.push(toParsedFile(block, hint.path, hint.source))
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
    files: hints.map((entry) => toParsedFile(entry.block, null, entry.hint.source)),
    strategy: 'user-assisted',
    warnings,
  }
}