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

Output ONLY a valid JSON object with a single key "files", which is an array of objects.
Do not output any prose, markdown formatting (like \`\`\`json), or explanatory text. Just the raw JSON.
Each object in the array must have exactly two keys:
- "path": the project-relative file path.
- "purpose": a brief, one-sentence explanation of why this file needs to change.

Rules:
- Use the exact paths shown in the skeleton. Never invent a path.
- Order from most relevant to least.
- Include 3 to 15 files. Never more than 20. Fewer is better when the change
  is small.
- Do not include files whose only role is to be read for context; include the
  files that would actually change.
- If the change clearly requires a new file, you may include a proposed path
  that does not exist yet, but only if no existing file fits.
- Skip lock files, generated files, assets, and vendored dependencies.`

/**
 * Pull project-relative paths and their purposes out of the assistant's JSON response.
 * Validates every survivor against the actual tree so a hallucinated path
 * never reaches the UI as if it were real.
 */
export function parseSuggestedFiles(
  text: string,
  known: Set<string>,
): { paths: string[]; purposes: Record<string, string>; hallucinated: string[] } {
  const seen = new Set<string>()
  const paths: string[] = []
  const purposes: Record<string, string> = {}
  const hallucinated: string[] = []

  let cleaned = text.trim()
  // Strip off common markdown formatting drift 
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')

  let items: any[] = []
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      items = parsed
    } else if (parsed && Array.isArray(parsed.files)) {
      items = parsed.files
    }
  } catch (e) {
    // Fallback for empty or completely malformed responses
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const token = item.path?.trim()
    if (!token) continue
    if (seen.has(token)) continue
    seen.add(token)

    if (known.has(token)) {
      paths.push(token)
      purposes[token] = item.purpose?.trim() ?? ''
    } else {
      hallucinated.push(token)
    }
    if (paths.length >= 20) break
  }
  return { paths, purposes, hallucinated }
}

export async function suggestFiles(
  request: AiSuggestRequest,
  providerId: AiProviderId,
): Promise<AiSuggestion> {
  const map = await buildCodebaseMap(request.projectRoot, request.filePaths)
  const mapTokens = countTokens(map.text)

  if (request.dryRun) {
    return {
      paths: [],
      purposes: {},
      provider: providerId,
      model: '',
      mapTokens,
      outputTokens: 0,
      durationMs: 0,
      hallucinated: [],
      method: 'current',
    }
  }

  const provider = getProvider(providerId)
  const apiKey = await getApiKey(providerId)
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${provider.label}. Add one in the Settings tab.`,
    )
  }
  const model = await resolveModel(providerId, provider.models[0] ?? '')

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
    temperature: 0,
  })
  const durationMs = Date.now() - started

  const known = new Set(request.filePaths)
  const { paths, purposes, hallucinated } = parseSuggestedFiles(text, known)

  return {
    paths,
    purposes,
    provider: providerId,
    model,
    mapTokens,
    outputTokens: countTokens(text),
    durationMs,
    hallucinated,
    method: 'current',
  }
}