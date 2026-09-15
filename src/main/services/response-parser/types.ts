import type { PathSource } from '@shared/types'

/** A fenced code block lifted out of a raw AI response. */
export interface CodeBlock {
  language: string | null
  /** Raw text between the fences. Never trimmed. */
  content: string
  /** Up to 3 lines immediately preceding the opening fence, joined with \n. */
  precedingText: string
  /** Original text from the opening fence line through the closing fence line. */
  rawBlock: string
  /** 1-based line number of the opening fence. */
  startLine: number
}

export interface PathHint {
  path: string | null
  source: PathSource
  ambiguous: boolean
}

/** A resolved (or unresolvable) code block, ready to become a ParsedFile. */
export interface ResolvedBlock {
  block: CodeBlock
  hint: PathHint
}
