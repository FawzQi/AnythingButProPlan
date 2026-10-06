import { countTokens } from 'gpt-tokenizer'
import type { AiSuggestion, AiSuggestRequest } from '@shared/types'
import { buildCodebaseMap } from './codebase-map'

/**
 * Measure the full-skeleton map token count for a project.
 *
 * This is a dry-run utility. It does not contact any provider and does not
 * select any files — it builds the same full-project skeleton that the
 * retired "current" method used to send, and reports its token count. The
 * Prompt tab shows that number in its footer as a rough measure of how
 * large a full-context request would be for the open project.
 *
 * The suggestion methods that remain (`gitnexus-only` and `gitnexus-jev`)
 * build a skeleton of only their surviving candidates, which is a small
 * fraction of this number. The measurement therefore stands on its own as
 * a project metric rather than as an input to a request that is about to
 * be made.
 *
 * `provider` and `model` on the returned result are display fields on
 * `AiSuggestion`. Nothing was called, so the provider reports the same
 * placeholder the local method uses and the model is empty.
 */
export async function measureMapTokens(
  request: AiSuggestRequest,
): Promise<AiSuggestion> {
  const map = await buildCodebaseMap(request.projectRoot, request.filePaths)
  return {
    paths: [],
    purposes: {},
    provider: 'deepseek',
    model: '',
    mapTokens: countTokens(map.text),
    outputTokens: 0,
    durationMs: 0,
    hallucinated: [],
    method: 'gitnexus-only',
  }
}