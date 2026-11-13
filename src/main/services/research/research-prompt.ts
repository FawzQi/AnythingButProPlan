import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countTokens } from 'gpt-tokenizer'
import type {
  ResearchPromptRequest,
  ResearchPromptResult,
} from '@shared/types'
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
 */
interface FullPromptDocument {
  name: string
  content: string
}

/**
 * Output contract shared by both research prompts.
 *
 * Deliberately not the coding contract. The coding parser treats
 * `===Files===` as the opening of a file-entry section and `File: <path>` as
 * a target path to write; a research answer carries citations instead, and a
 * citation labelled `File:` would be read as an edit and offered for writing
 * to disk. No marker here is a word the coding parser looks for, so a
 * research reply stays distinguishable from a coding reply by its first line
 * even after both have been through a clipboard and back.
 *
 * `===Debug===` is likewise avoided: `extractDebugCommands` would read it as
 * shell commands to run, and a research answer has no business producing
 * commands the app might execute.
 *
 * The one variant is the noun: the retrieval prompt cites passages lifted out
 * of documents, the whole-document prompt cites the documents themselves.
 */
export function researchOutputInstructions(
  sourceKind: 'passage' | 'document',
): string {
  const plural = sourceKind === 'passage' ? 'passages' : 'documents'
  return `## Output Instructions

Produce your response in exactly the format below, and nothing else. Each
section opens with a marker line — the section name wrapped in three equals
signs on each side — and closes with a line of six equals signs. Do not add
anything before the first marker line or after the last closing line.

The overall shape is:

    ===Sources===
    <source entries>
    ======
    ===Answer===
    <prose answer>
    ======
    ===Checks===
    <verification steps>
    ======

### The Sources section

One entry per ${sourceKind} the answer draws on, in the order the ${plural}
appear above. Each entry is a \`Source:\` line naming the document and the
section heading, followed by the ${sourceKind}'s text in a fenced block,
copied verbatim. Example:

Source: paper-a.pdf, "3 Methodology > 3.2 Data Collection"

\`\`\`text
<the ${sourceKind}'s text, exactly as it appears above>
\`\`\`

The marker names are load-bearing. The same app also reads coding replies,
where \`===Files===\` opens a list of files to write and \`File:\` names a
path on disk. A citation labelled \`File:\` would be read as a target file,
so \`Source:\` is what keeps a quotation from being mistaken for an edit.

### The Answer section

Your answer to the question, in prose. Lead with the answer, then the
evidence. Cite the sources you used — see "Citing sources" below.

### The Checks section

Steps a reader could take to verify the answer, or the single word None if
no verification is meaningful.

### Citing sources

Inside the Answer section, cite the sources you used, in this form:

- \`paper-a.pdf, "3 Methodology > 3.2 Data Collection"\` — the document and
  the section heading, copied exactly as it appears above.
- \`paper-a.pdf, abstract\` — a claim taken from the summary at the top of a
  document rather than from its body.

A claim drawn from two documents gets two citations.

### What not to do

- Do not open with \`===Files===\` and do not label an entry \`File:\`. That
  is the coding format, and it is read as a file to write rather than a
  source to cite.
- Do not invent citations, and do not cite a document you did not read in
  the ${plural} above.
- Do not treat the ${plural} as complete. If they do not contain the answer,
  say what is missing — the reader can supply different ${plural}.
- If two ${plural} disagree, present both with their citations instead of
  picking one.
- Do not pad the answer with a summary of every ${sourceKind}. Use the ones
  that bear on the question and leave the rest.
- Do not add prose outside the three sections. The parser reads the marker
  lines literally; anything before \`===Sources===\` or after the final
  \`======\` is dropped.`
}

function renderFullPrompt(
  documents: FullPromptDocument[],
  question: string,
): string {
  const renderedDocs = documents
    .map((d) => `### ${d.name}\n\n${d.content}\n\n`)
    .join('')
  const task =
    question !== ''
      ? question
      : 'Read the documents above and answer the question at the end of this prompt.'

  return `# Research Context

## Documents

${renderedDocs}
## Your Task

${task}

${researchOutputInstructions('document')}`
}

interface RagPromptDocument {
  name: string
  abstract: string
}

interface RagPromptExcerpt {
  number: number
  document: string
  heading: string
  text: string
}

function renderRagPrompt(
  question: string,
  documents: RagPromptDocument[],
  excerpts: RagPromptExcerpt[],
  chunkCount: number,
): string {
  const renderedDocs = documents
    .map((d) => `### ${d.name}\n\n${d.abstract}\n\n`)
    .join('')
  const renderedExcerpts = excerpts
    .map(
      (e) =>
        `### Excerpt ${e.number} — ${e.document}, "${e.heading}"\n\n${e.text}\n\n`,
    )
    .join('')

  return `# Research Question

${question}

## Source Documents

One abstract per document the excerpts below were drawn from. The abstracts
are here so the excerpts make sense — an excerpt from the middle of a paper
refers to concepts the abstract names. Read these first.

${renderedDocs}
## Retrieved Excerpts

The ${chunkCount} excerpts below were retrieved as the passages most likely to
answer the question. They are not the whole documents, and they may overlap or
leave gaps. Each one is labelled with the document and section it came from.

${renderedExcerpts}
${researchOutputInstructions('passage')}`
}

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
    const prompt = renderFullPrompt(
      documents,
      request.question?.trim() ?? '',
    )
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

  const prompt = renderRagPrompt(
    question,
    preambles.map((preamble) => ({
      name: path.posix.basename(preamble.path),
      abstract: preamble.abstract,
    })),
    excerpts,
    excerpts.length,
  )

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
