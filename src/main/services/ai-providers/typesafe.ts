import type { AiProvider, CompleteInput } from './types'

/**
 * TypeSafe hosts Jev, a typed-decision model. It is not a chat model and it
 * does not speak the OpenAI Chat Completions shape — it takes a state plus
 * a set of typed questions (Choice / Score / Noul) and returns typed answers
 * with calibrated probabilities.
 *
 * Registering it here does two things for the app:
 *
 *   1. It gives the Jev API key the same encrypted-at-rest storage the chat
 *      providers get. `getApiKey('typesafe')` returns the plaintext only
 *      inside the main process, immediately before the outbound call.
 *
 *   2. It surfaces the Jev model names in the Settings picker, so the user
 *      can pick which Jev checkpoint the `gitnexus-jev` method calls.
 *
 * `complete()` deliberately throws. Jev cannot answer a chat completion, and
 * pretending it can would let a user select TypeSafe as their main provider
 * for the `current` or `gitnexus` methods and get a confusing failure deep
 * in the pipeline instead of a clear error at the point of misuse.
 */
export const typesafeProvider: AiProvider = {
  id: 'typesafe',
  label: 'TypeSafe (Jev)',
  keyUrl: 'https://typesafe.ai/console',
  models: ['jev-latest', 'jev-1.13', 'jev-1.13-free'],
  async complete(_input: CompleteInput): Promise<string> {
    throw new Error(
      'TypeSafe is a typed-decision provider and cannot answer chat ' +
        'completions. Select it only when using the "GitNexus + Jev" ' +
        'suggestion method, or choose a chat provider (DeepSeek, Groq, ' +
        'OpenRouter, or Google AI Studio) for the other methods.',
    )
  },
}