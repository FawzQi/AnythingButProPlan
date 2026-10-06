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

## Output Instructions

Answer in prose. Lead with the answer, then the evidence for it.

### Citing sources

Every factual claim taken from a document must name the document it came from, like this:

- \`paper-a.pdf, "3 Methodology > 3.2 Data Collection"\` — for a claim from a specific section.
- \`paper-a.pdf, abstract\` — for a claim from the summary at the top of a document.

Quote the section heading exactly as it appears in the document. If a claim draws on several documents, cite each of them.

### What not to do

- Do not invent citations. If a document does not support a claim, either find the passage that does or say the documents do not cover it.
- Do not attribute a claim to a document whose text you did not use.
- Do not restate the question or summarise the documents section by section unless asked to.
- If the documents disagree, say so and cite both sides rather than picking one silently.
- If the documents do not answer the question, say that plainly. That is a useful answer; a confident wrong one is not.
`
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

const RAG_OUTPUT_INSTRUCTIONS = `## Output Instructions

Produce your response in exactly the format below, and nothing else. Each
section opens with a marker line — the section name wrapped in three equals
signs on each side — and closes with a line of six equals signs. Do not add
anything before the first marker line or after the last closing line.

The overall shape is:

    ===Files===
    <file entries>
    ======
    ===Explanation===
    <prose answer>
    ======
    ===Debug===
    <verification steps>
    ======

### The Files section

One entry per excerpt the answer draws on, in the order the excerpts appear
above. Each entry is a \`File:\` line followed by the excerpt's text in a
fenced block, copied verbatim. Example:

File: paper-a.pdf, "3 Methodology > 3.2 Data Collection"

\`\`\`text
<the excerpt's text, exactly as it appears above>
\`\`\`

### The Explanation section

Your answer to the question, in prose. Lead with the answer, then the
evidence. Cite the excerpt labels you used — see "Citing sources" below.

### The Debug section

Steps a reader could take to verify the answer, or the single word None if
no verification is meaningful.

### Citing sources

Inside the Explanation section, cite the excerpt labels you used, in this form:

- \`paper-a.pdf, "3 Methodology > 3.2 Data Collection"\` — the document and
  the section heading, copied exactly as it appears on the excerpt.

A claim drawn from two documents gets two citations. A claim drawn from an
abstract rather than an excerpt is cited as \`paper-a.pdf, abstract\`.

### What not to do

- Do not invent citations, and do not cite a document you did not read in the
  excerpts above.
- Do not treat the excerpts as complete. If they do not contain the answer,
  say what is missing — the reader can retrieve different passages.
- If two excerpts disagree, present both with their citations instead of
  picking one.
- Do not pad the answer with a summary of every excerpt. Use the ones that
  bear on the question and leave the rest.
- Do not add prose outside the three sections. The parser reads the marker
  lines literally; anything before \`===Files===\` or after the final \`======\`
  is dropped.`

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
${RAG_OUTPUT_INSTRUCTIONS}`
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
