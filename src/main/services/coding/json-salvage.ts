/**
 * Pull a JSON object out of whatever a chat model actually returned.
 *
 * Every model in the app's provider list is asked for bare JSON and most of
 * them comply, but the drift is predictable and repeating: a fenced ```json
 * block, a trailing comma, a stray `assistant:` or `Here you go:` prefix,
 * trailing prose after the closing brace. A strict `JSON.parse` on the raw
 * text fails on all of them, and the failure mode is the expensive one — the
 * caller sees an empty result and reports "the model returned nothing" for a
 * response that contained the answer.
 *
 * Extracted into its own module when the second caller appeared (image
 * analysis, after the file ranker): two copies of this would drift, and the
 * salvage rules are exactly the kind of thing that gets fixed in one copy and
 * forgotten in the other.
 */
export function extractJsonObject(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = body.slice(start, end + 1)

  try {
    return JSON.parse(candidate)
  } catch {
    // A trailing comma before a closing brace is the single most common
    // malformation. Strip those and retry once; anything else falls through
    // to `null` and the caller reports "no usable answer".
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      return null
    }
  }
}

/** Entries of a model-returned list, wherever it put the array. */
export function asObjectList(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}
