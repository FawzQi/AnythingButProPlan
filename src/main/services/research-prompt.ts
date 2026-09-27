import { promises as fs } from 'node:fs'
import path from 'node:path'
import Handlebars from 'handlebars'
import { countTokens } from 'gpt-tokenizer'
import type {
  ResearchPromptRequest,
  ResearchPromptResult,
} from '@shared/types'
import fullTemplateSource from '../../../resources/prompt-templates/research.hbs?raw'
import ragTemplateSource from '../../../resources/prompt-templates/research-rag.hbs?raw'
import { markdownPathFor, scanDocuments } from './document-scanner'
import { collectAbstracts, retrieve } from './retriever'

/**
 * The two research prompts.
 *
 * `full` inlines every converted document. It is the honest baseline: no
 * retrieval, no ranking, nothing between the user's question and the text.
 * For two or three papers it is also the best answer, because a retrieval
 * pass can only lose information that the model would otherwise have had.
 *
 * `rag` retrieves excerpts and, critically, includes one abstract per source
 * document as a preamble before them. The abstracts are not optional and are
 * not a nicety: a 300-token excerpt that says "the proposed method improves
 * on both baselines" is unreadable without knowing what the method is, and a
 * model given only the excerpt will confidently attribute the claim to the
 * wrong paper. See CLAUDE.md, "RAG retrieval".
 *
 * Both templates are imported with Vite's `?raw` suffix so the prompt lives
 * in `resources/prompt-templates/` where it can be read and edited as
 * Handlebars rather than as a string in TypeScript.
 */
const fullTemplate = Handlebars.compile(fullTemplateSource, { noEscape: true })
const ragTemplate = Handlebars.compile(ragTemplateSource, { noEscape: true })

const MAX_FULL_DOCUMENT_BYTES = 400_000

export async function buildResearchPrompt(
  request: ResearchPromptRequest,
): Promise<ResearchPromptResult> {
  const scan = await scanDocuments(request.projectRoot)
  // The selection is taken from the scan rather than from the converted
  // subset, so a selected document that has not been converted is reported
  // as unreadable instead of vanishing from the prompt with no mention.
  const selected =
    request.docPaths.length === 0
      ? scan.documents
      : scan.documents.filter((document) =>
          request.docPaths.includes(document.path),
        )
  const wanted = selected.filter((document) => document.convertedExists)

  if (wanted.length === 0) {
    throw new Error(
      scan.documents.length === 0
        ? 'No documents found. Put files in docs/ and convert them first.'
        : 'None of the selected documents have been converted yet.',
    )
  }

  const unreadable: string[] = selected
    .filter((document) => !document.convertedExists)
    .map((document) => document.path)

  if (request.mode === 'full') {
    const documents: { name: string; content: string }[] = []
    for (const document of wanted) {
      try {
        const content = await fs.readFile(
          markdownPathFor(request.projectRoot, document.slug),
          'utf8',
        )
        documents.push({
          name: document.path,
          // A whole-paper inline is the point of this mode, but an extractor
          // that emitted a megabyte (scanned appendices, mostly) would push
          // the prompt past every model's context and fail at the vendor
          // rather than here. Truncate loudly instead.
          content:
            content.length > MAX_FULL_DOCUMENT_BYTES
              ? `${content.slice(0, MAX_FULL_DOCUMENT_BYTES)}\n\n[truncated — this document exceeded ${Math.round(MAX_FULL_DOCUMENT_BYTES / 1000)}k characters]`
              : content,
        })
      } catch {
        unreadable.push(document.path)
      }
    }
    if (documents.length === 0) {
      throw new Error(
        `Could not read any of the ${wanted.length} selected document(s). Re-convert them and try again.`,
      )
    }
    const prompt = fullTemplate({
      documents,
      question: request.question?.trim() ?? '',
    })
    return {
      prompt,
      tokenCount: countTokens(prompt),
      documentCount: documents.length,
      chunkCount: 0,
      documents: documents.map((document) => document.name),
      citations: [],
      unreadable,
    }
  }

  const question = request.question?.trim() ?? ''
  if (question === '') {
    throw new Error(
      'A RAG prompt needs a question. Type one above the Build prompt button.',
    )
  }

  const topK = request.topK ?? 8
  const result = await retrieve({
    projectRoot: request.projectRoot,
    question,
    documentPaths: wanted.map((document) => document.path),
    topK,
    rerank: request.rerank === true,
  })

  const usedDocuments = new Set(result.hits.map((hit) => hit.chunk.document))
  const preambles = await collectAbstracts(
    request.projectRoot,
    wanted.filter((document) => usedDocuments.has(document.path)),
  )
  if (preambles.length === 0) {
    unreadable.push(...wanted.map((document) => document.path))
  }

  const excerpts = result.hits.map((hit, index) => ({
    number: index + 1,
    document: hit.chunk.document,
    heading: hit.chunk.headingPath === '' ? 'no heading' : hit.chunk.headingPath,
    text: hit.chunk.text,
  }))

  const prompt = ragTemplate({
    question,
    documents: preambles.map((preamble) => ({
      name: path.posix.basename(preamble.path),
      abstract: preamble.abstract,
    })),
    excerpts,
    chunkCount: excerpts.length,
  })

  return {
    prompt,
    tokenCount: countTokens(prompt),
    documentCount: preambles.length,
    chunkCount: excerpts.length,
    documents: preambles.map((preamble) => preamble.path),
    citations: excerpts.map((excerpt) => ({
      document: path.posix.basename(excerpt.document),
      heading: excerpt.heading,
    })),
    unreadable,
  }
}
