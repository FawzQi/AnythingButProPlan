import { countTokens } from 'gpt-tokenizer'
import type {
  AiProviderId,
  AiSuggestion,
  AiSuggestRequest,
} from '@shared/types'
import { buildCodebaseMap } from './codebase-map'
import { getProvider } from './ai-providers'
import { getApiKey, resolveModel } from './settings'

const SYSTEM_PROMPT = `You select files from a codebase to answer a feature request.

You will receive a skeleton of the project (one entry per file, with its
exported signatures and dependencies) and a user instruction describing a
change to make.

Output ONLY a newline-separated list of project-relative file paths.

Rules:
- Use the exact paths shown in the skeleton. Never invent a path.
- Order from most relevant to least.
- Include 3 to 15 files. Never more than 20. Fewer is better when the change
  is small.
- Do not include files whose only role is to be read for context; include the
  files that would actually change.
- Do not output any explanatory text, prose, markdown fences, bullets, or
  numbering. One path per line, nothing else.
- If the change clearly requires a new file, you may include a proposed path
  that does not exist yet, but only if no existing file fits.
- Skip lock files, generated files, assets, and vendored dependencies.`

/**
 * Pull project-relative paths out of the assistant's text. The model is
 * instructed to return bare paths, one per line, but small models drift —
 * they add backticks, bullets, and "File: " prefixes. Strip those and
 * validate every survivor against the actual tree so a hallucinated path
 * never reaches the UI as if it were real.
 */
function parseSuggestedPaths(
  text: string,
  known: Set<string>,
): { paths: string[]; hallucinated: string[] } {
  const seen = new Set<string>()
  const paths: string[] = []
  const hallucinated: string[] = []
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim()
    if (line === '') continue
    // Strip common drift: bullets, numbering, backticks, "File: " prefixes.
    line = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '')
    line = line.replace(/^`+|`+$/g, '')
    line = line.replace(/^File:\s*/i, '')
    line = line.replace(/^"|"$/g, '')
    // Take the first whitespace-delimited token; models sometimes append a
    // trailing "(why)" clause.
    const token = line.split(/\s+/)[0] ?? ''
    if (token === '') continue
    if (seen.has(token)) continue
    seen.add(token)
    if (known.has(token)) paths.push(token)
    else hallucinated.push(token)
    if (paths.length >= 20) break
  }
  return { paths, hallucinated }
}

export async function suggestFiles(
  request: AiSuggestRequest,
  providerId: AiProviderId,
): Promise<AiSuggestion> {
  const provider = getProvider(providerId)
  const apiKey = await getApiKey(providerId)
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${provider.label}. Add one in the Settings tab.`,
    )
  }
  const model = await resolveModel(providerId, provider.models[0] ?? '')

  const map = await buildCodebaseMap(request.projectRoot, request.filePaths)
  const mapTokens = countTokens(map.text)

  const user = [
    'Project skeleton:',
    '',
    map.text,
    '',
    '---',
    '',
    'Instruction:',
    request.instruction.trim(),
    '',
    'Return the list of file paths now.',
  ].join('\n')

  const started = Date.now()
  const text = await provider.complete({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 1024,
    temperature: 0.1,
  })
  const durationMs = Date.now() - started

  const known = new Set(request.filePaths)
  const { paths, hallucinated } = parseSuggestedPaths(text, known)

  return {
    paths,
    provider: providerId,
    model,
    mapTokens,
    outputTokens: countTokens(text),
    durationMs,
    hallucinated,
  }
}