import type { PathSource } from '@shared/types'

/** A fenced code block lifted out of a raw AI response. */
export interface CodeBlock {
  language: string | null
  /** Raw text between the fences. Never trimmed. */
  content: string
  /**
   * Lines immediately preceding the opening fence, joined with \n. The window
   * is sized so a `File: <path>` header separated from the fence by a blank
   * line (or two) is still inside it; see `PRECEDING_WINDOW` in the markdown
   * parser for the exact count.
   */
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
