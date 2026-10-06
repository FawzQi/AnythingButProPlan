import { countTokens } from 'gpt-tokenizer'

/**
 * Heading-aware chunker for converted documents.
 *
 * 300 tokens with 50 tokens of overlap is deliberate and is not a tuning
 * knob the user should reach for first: research papers are dense, and a
 * 500-token chunk routinely straddles two unrelated paragraphs and embeds
 * into a vector that matches neither. The overlap exists because a claim and
 * the sentence that qualifies it frequently land either side of a boundary,
 * and a chunk that loses its qualifier retrieves as a stronger claim than
 * the paper makes.
 *
 * The heading path (`3 Methodology > 3.2 Data Collection`) is carried on
 * every chunk rather than being flattened into the text. It is what the
 * citation header in a retrieval prompt quotes verbatim, and it is the only
 * orientation the model gets for a 300-token excerpt lifted out of a
 * 40-page paper. Do not flatten it into the chunk body — the citation
 * rendering depends on it being a separate field.
 */

export interface Chunk {
  /** Stable id: `document#index`. Used to match vectors to chunks. */
  id: string
  /** POSIX path of the source document, relative to `docs/`. */
  document: string
  /** Full heading path, `>`-joined. Empty when the document has no headings. */
  headingPath: string
  /** 0-based position of this chunk within the document. */
  index: number
  text: string
  tokens: number
}

export interface ChunkOptions {
  /** Target chunk size in tokens. */
  tokens?: number
  /** Tokens repeated from the end of the previous chunk. */
  overlap?: number
}

export const CHUNK_TOKENS = 300
export const CHUNK_OVERLAP = 50

interface Section {
  headingPath: string
  text: string
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/

/**
 * Split markdown into sections at headings.
 *
 * Fenced code blocks are tracked so a `#` comment inside a Python or shell
 * block does not open a section. A heading that only exists inside a fence is
 * how a chunk gets filed under a heading that is really a comment, and the
 * resulting citation is nonsense to the reader.
 */
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n')
  const stack: { level: number; title: string }[] = []
  const sections: Section[] = []
  let current: string[] = []
  let inFence = false
  let fenceMarker = ''

  const flush = (): void => {
    const text = current.join('\n').trim()
    if (text !== '') {
      sections.push({
        headingPath: stack.map((entry) => entry.title).join(' > '),
        text,
      })
    }
    current = []
  }

  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? ''
      if (!inFence) {
        inFence = true
        fenceMarker = marker[0] ?? '`'
      } else if (marker[0] === fenceMarker) {
        inFence = false
      }
      current.push(line)
      continue
    }

    const heading = inFence ? null : HEADING.exec(line)
    if (heading === null) {
      current.push(line)
      continue
    }

    flush()
    const level = heading[1]?.length ?? 1
    const title = heading[2] ?? ''
    // Pop until the stack holds only ancestors of this heading. Comparing
    // levels rather than positions is what makes a document that starts at
    // `##` behave: the first `##` is a root, and a later `##` is its sibling,
    // not its child. A positional rule would nest every heading one level
    // deeper than the document does.
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop()
    }
    stack.push({ level, title })
  }

  flush()
  return sections
}

/**
 * Split a section's text into sentence-ish units for boundary selection.
 *
 * Sentence splitting is naive on purpose — abbreviations and decimals will
 * occasionally split a sentence that should not have split. The cost is a
 * chunk boundary in an odd place, which the overlap then papers over; the
 * alternative is a sentence tokenizer with an abbreviation list, which is a
 * dependency and a maintenance burden for a chunk boundary.
 */
function sentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z(["'`*_])|\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return parts.length > 0 ? parts : [text]
}

function windowSection(
  section: Section,
  document: string,
  startIndex: number,
  targetTokens: number,
  overlapTokens: number,
): Chunk[] {
  const chunks: Chunk[] = []
  const units = sentences(section.text)
  let buffer: string[] = []
  let bufferTokens = 0
  let index = startIndex

  const emit = (): void => {
    const text = buffer.join(' ').trim()
    if (text === '') return
    chunks.push({
      id: `${document}#${index}`,
      document,
      headingPath: section.headingPath,
      index,
      text,
      tokens: bufferTokens,
    })
    index += 1
  }

  for (const unit of units) {
    const unitTokens = countTokens(unit)
    // An oversized single sentence (a table dumped as text, a formula)
    // becomes its own chunk rather than being split mid-sentence: a chunk
    // that ends mid-clause retrieves worse than one that is too long.
    if (buffer.length > 0 && bufferTokens + unitTokens > targetTokens) {
      emit()
      const carried: string[] = []
      let carriedTokens = 0
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        const candidate = buffer[i] ?? ''
        const candidateTokens = countTokens(candidate)
        if (carriedTokens + candidateTokens > overlapTokens) break
        carried.unshift(candidate)
        carriedTokens += candidateTokens
      }
      buffer = [...carried, unit]
      bufferTokens = carriedTokens + unitTokens
    } else {
      buffer.push(unit)
      bufferTokens += unitTokens
    }
  }
  emit()
  return chunks
}

export function chunkMarkdown(
  document: string,
  markdown: string,
  options: ChunkOptions = {},
): Chunk[] {
  const targetTokens = options.tokens ?? CHUNK_TOKENS
  const overlapTokens = options.overlap ?? CHUNK_OVERLAP
  const chunks: Chunk[] = []
  for (const section of splitSections(markdown)) {
    chunks.push(
      ...windowSection(
        section,
        document,
        chunks.length,
        targetTokens,
        overlapTokens,
      ),
    )
  }
  return chunks
}
