import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ConvertProgress,
  DocumentEntry,
  WebChatTargetId,
} from '@shared/types'
import { isCancelled } from './cancellation'
import {
  convertedRoot,
  documentsRoot,
  markdownPathFor,
  readState,
  scanDocuments,
  slugFor,
  writeState,
} from './document-scanner'
import { resolveWithinRoot, toPosix, writeFileEnsuringDir } from './fs-service'
import { parseResponse } from './response-parser'

/**
 * The `webchat` extractor: convert a document by handing it to a chat model.
 *
 * The document itself is attached to the chat — not its extracted text. That
 * is the point of the engine: the model sees the figures, the charts and the
 * page layout, so it can describe a figure from the image rather than from a
 * caption, and rebuild a chart as a table from the plotted numbers. A local
 * extractor cannot do either, and pre-extracting the text would throw away
 * exactly the information this path exists to use.
 *
 * The exchange is deliberately shaped like a code-generation turn, because
 * the app already has the machinery for one:
 *
 *   prompt  → "convert the attached document, reply with `File: <path>` and a
 *              fenced markdown block" (see `conversionPrompt`)
 *   reply   → parsed by the coding-mode response parser, which understands
 *              `File:` headers and fenced blocks
 *   write   → `planConversionWrite` below, then the same
 *              `writeFileEnsuringDir` the other engines use
 *
 * The reply is untrusted input. A model that answers with a path somewhere
 * else in the project, with SEARCH/REPLACE patches, or with a `Delete:`
 * directive must not be able to touch anything outside `converted/`, so the
 * plan step refuses all of those and reports each refusal.
 */

export interface WebChatConvertRequest {
  projectRoot: string
  /** Documents to convert, `docs/`-relative. */
  docPaths: string[]
  target: WebChatTargetId
  onProgress: (progress: ConvertProgress) => void
  /**
   * How to reach the chat. Injected so the parse/write half of this module is
   * testable without a browser window.
   */
  send: (
    prompt: string,
    absoluteDocumentPath: string,
  ) => Promise<{ ok: boolean; text?: string; error?: string; attached: boolean }>
}

export interface WebChatConvertResult {
  documents: DocumentEntry[]
  failed: { path: string; error: string }[]
  cancelled: boolean
}

/**
 * What the chat model is asked for.
 *
 * The target path is interpolated rather than described, because the reply is
 * applied by path: a model that invents `converted/paper.md` produces a write
 * that has to be refused, and the user is left with a conversion that looks
 * like it failed for no reason. Naming the path in the prompt removes that
 * failure mode entirely.
 */
export function conversionPrompt(options: {
  documentPath: string
  targetPath: string
}): string {
  return [
    'Convert the attached document into markdown.',
    '',
    'Rules:',
    '- Keep the document\'s own structure: its headings become `#`/`##`/`###` at their own levels.',
    '- Remove running heads, page numbers, and footers.',
    '- For every figure, add one line: `> **Figure**: <what it shows, and what it means here>`.',
    '  Describe the figure from the image itself. If you genuinely cannot tell what it',
    '  shows, write `> **Figure**: description unavailable` rather than guessing.',
    '- For every chart or table, produce a markdown table with a header row and the units',
    '  from the axis or caption. Rebuild it from the numbers in the figure. If the numbers',
    '  are not legible, write one line saying so instead of inventing values.',
    '- Keep equations as inline code or fenced blocks.',
    '- Copy the prose verbatim. Do not summarise, shorten, or paraphrase: this output',
    '  replaces the document in a retrieval corpus, and a paraphrase loses the authors\' claims.',
    '',
    'Reply with exactly this, and nothing else:',
    '',
    `File: ${options.targetPath}`,
    '',
    '```markdown',
    '<the complete markdown for the attached document>',
    '```',
    '',
    `The document is "${options.documentPath}". The File: line must read exactly "${options.targetPath}".`,
  ].join('\n')
}

export interface ConversionPlan {
  content: string | null
  /** Why the reply could not be used. Present when `content` is null. */
  problem: string | null
  /** Entries the reply contained that were refused, with reasons. */
  refused: { path: string; reason: string }[]
}

/**
 * Decide what of a chat reply may be written.
 *
 * Only the file this conversion asked for is accepted. A reply that also
 * contains other `converted/` paths is not a bonus — it means the model
 * answered a different question than the one asked, and writing a document
 * the user did not select would be a surprise they cannot undo.
 */
export function planConversionWrite(
  reply: string,
  expectedTarget: string,
  parsed: Awaited<ReturnType<typeof parseResponse>>,
): ConversionPlan {
  const refused: { path: string; reason: string }[] = []
  let match: string | null = null

  for (const file of parsed.files) {
    const candidate = file.path === null ? null : toPosix(file.path).replace(/^\.?\//, '')
    if (candidate === null) {
      refused.push({
        path: '(no path)',
        reason: 'the reply named no file — it may have answered in prose',
      })
      continue
    }
    if (candidate !== expectedTarget) {
      refused.push({
        path: candidate,
        reason: `not the requested target (${expectedTarget})`,
      })
      continue
    }
    if (file.delete === true || (file.patches !== undefined && file.patches.length > 0)) {
      refused.push({
        path: candidate,
        reason: 'a rewrite reply must be a whole file, not a patch or a delete',
      })
      continue
    }
    if (file.content.trim() === '') {
      refused.push({ path: candidate, reason: 'the fenced block was empty' })
      continue
    }
    match = file.content
  }

  if (match !== null) return { content: match, problem: null, refused }

  const problem =
    parsed.files.length === 0
      ? `the reply contained no \`File:\` block. It began: ${reply.trim().slice(0, 200)}`
      : refused.length > 0
        ? `${refused.length} entr(ies) in the reply were refused: ${refused
            .slice(0, 3)
            .map((entry) => `${entry.path} (${entry.reason})`)
            .join('; ')}`
        : 'the reply contained nothing usable'
  return { content: null, problem, refused }
}

/**
 * Convert every requested document through the chat, one at a time.
 *
 * Sequential on purpose: the sites rate-limit, and a second conversion started
 * while the first is streaming would be typed into a composer that is still
 * busy. Cancellation is checked between documents, so a cancelled batch keeps
 * every document already written.
 */
export async function convertDocumentsViaWebChat(
  request: WebChatConvertRequest,
): Promise<WebChatConvertResult> {
  const { projectRoot, target, onProgress, send } = request
  const state = await readState(projectRoot)
  const failed: { path: string; error: string }[] = []
  let cancelled = false

  const targets =
    request.docPaths.length === 0
      ? (await fs.readdir(documentsRoot(projectRoot), { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
      : request.docPaths

  for (const [position, documentPath] of targets.entries()) {
    if (isCancelled(projectRoot)) {
      cancelled = true
      break
    }

    const slug = slugFor(documentPath)
    const report = (stage: ConvertProgress['stage'], message: string): void => {
      onProgress({
        path: documentPath,
        index: position + 1,
        total: targets.length,
        stage,
        message,
      })
    }

    const absolute = resolveWithinRoot(documentsRoot(projectRoot), documentPath)
    const targetPath = toPosix(path.relative(projectRoot, markdownPathFor(projectRoot, slug)))

    try {
      report('chatting', `Sending ${path.basename(documentPath)} to ${target}`)
      const reply = await send(
        conversionPrompt({ documentPath, targetPath }),
        absolute,
      )

      if (!reply.ok) {
        throw new Error(reply.error ?? 'The web chat did not answer.')
      }

      report('saving', `Reading the reply for ${path.basename(documentPath)}`)
      const parsed = await parseResponse(reply.text ?? '')
      const plan = planConversionWrite(reply.text ?? '', targetPath, parsed)
      if (plan.content === null) {
        throw new Error(`Could not use the reply — ${plan.problem}`)
      }

      const markdown = plan.content.endsWith('\n') ? plan.content : `${plan.content}\n`
      await fs.mkdir(convertedRoot(projectRoot), { recursive: true })
      await writeFileEnsuringDir(markdownPathFor(projectRoot, slug), markdown)

      state[slug] = {
        path: documentPath,
        status: 'converted',
        mode: 'text',
        convertedAt: Date.now(),
        error:
          reply.attached === false
            ? 'The document could not be attached to the chat window, so the model answered without it. Check the reply before using this conversion.'
            : undefined,
      }
      await writeState(projectRoot, state)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push({ path: documentPath, error: reason })
      state[slug] = {
        path: documentPath,
        status: 'failed',
        error: reason,
      }
      await writeState(projectRoot, state)
    }
  }

  return {
    documents: (await scanDocuments(projectRoot)).documents,
    failed,
    cancelled,
  }
}
