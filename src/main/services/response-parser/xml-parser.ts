import { XMLParser } from 'fast-xml-parser'
import type { CodeBlock } from './types'
import { extractCodeBlocks } from './markdown-parser'

export interface XmlFileBlock {
  path: string | null
  block: CodeBlock
}

const OPENING_TAG = /<file\b([^>]*)>/gi
const CLOSING_TAG = /<\/file\s*>/gi

/**
 * Strip the markdown fence the output contract wraps around each file body and
 * report its language. Only the outer blank padding of the envelope is removed;
 * everything inside the fence is returned untouched.
 */
function unwrapFence(body: string): { content: string; language: string | null } {
  const blocks = extractCodeBlocks(body)
  const only = blocks[0]
  if (blocks.length === 1 && only && only.content.trim() !== '') {
    return { content: only.content, language: only.language }
  }
  // No usable fence: keep the body, dropping only the envelope's blank padding.
  return { content: body.replace(/^\n+/, '').replace(/\n+$/, ''), language: null }
}

/**
 * Read a `<file ...>` opening tag's attributes with the XML parser. Only the
 * tag itself goes through it — the body is sliced straight out of the raw text
 * so line endings and bytes survive untouched.
 */
function parseAttributes(attributeText: string): Record<string, unknown> | null {
  try {
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
      parseTagValue: false,
    }).parse(`<file${attributeText}></file>`)
    const node = (parsed as Record<string, unknown>)['file']
    return node != null && typeof node === 'object' ? (node as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readPath(attributes: Record<string, unknown> | null): string | null {
  if (!attributes) return null
  for (const key of ['@_path', 'path', '@_file', 'file']) {
    const value = attributes[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

interface RawTag {
  path: string | null
  body: string
}

/** Pair each `<file>` with its `</file>`, slicing bodies out of the raw text. */
function scanTags(raw: string): RawTag[] {
  const tags: RawTag[] = []
  OPENING_TAG.lastIndex = 0
  let opening = OPENING_TAG.exec(raw)

  while (opening) {
    const bodyStart = opening.index + opening[0].length
    CLOSING_TAG.lastIndex = bodyStart
    const closing = CLOSING_TAG.exec(raw)
    if (!closing) break

    tags.push({
      path: readPath(parseAttributes(opening[1] ?? '')),
      body: raw.slice(bodyStart, closing.index),
    })
    OPENING_TAG.lastIndex = closing.index + closing[0].length
    opening = OPENING_TAG.exec(raw)
  }

  return tags
}

/**
 * Strategy 1: the strict `<file path="...">...</file>` envelope.
 *
 * Bodies are sliced out of the raw string rather than handed to the XML parser:
 * a real XML parser normalizes CRLF to LF and would rewrite a file's line
 * endings on the way through. Attributes are still parsed as XML.
 */
export function parseXmlEnvelope(raw: string): XmlFileBlock[] {
  return scanTags(raw)
    .map((tag) => {
      const { content, language } = unwrapFence(tag.body)
      const block: CodeBlock = {
        language,
        content,
        precedingText: '',
        rawBlock: tag.body,
        startLine: 0,
      }
      return { path: tag.path, block }
    })
    .filter((entry) => entry.block.content.trim() !== '' || entry.path != null)
}
