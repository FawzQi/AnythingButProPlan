import type { AiProviderId } from '@shared/types'
import type { AiProvider, CompleteInput } from './types'
import { describeFetchError, httpFetch } from './http'

interface OpenAiCompatibleOptions {
  id: AiProviderId
  label: string
  keyUrl: string
  models: string[]
  baseUrl: string
  /** Extra headers some vendors require (OpenRouter wants Referer + Title). */
  extraHeaders?: Record<string, string>
}

/**
 * Factory for the vendors that speak the OpenAI Chat Completions shape.
 * DeepSeek, Groq, and OpenRouter all accept the same request body and
 * return the same response envelope; Google AI Studio does not, and has
 * its own file.
 *
 * Requests go through `httpFetch` (Chromium's network stack) rather than
 * the global `fetch`, which is what makes proxy and dual-stack network
 * setups work. See `http.ts` for the reasoning.
 */
export function makeOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): AiProvider {
  return {
    id: options.id,
    label: options.label,
    keyUrl: options.keyUrl,
    models: options.models,
    async listModels(apiKey: string): Promise<string[]> {
      // Every OpenAI-compatible vendor places the model list at the sibling
      // of `/chat/completions`: strip the chat segment and append `/models`.
      // This works for DeepSeek, Groq, and OpenRouter without per-vendor
      // configuration.
      const modelsUrl = options.baseUrl.replace(
        /\/chat\/completions\/?$/,
        '/models',
      )
      let response: Response
      try {
        response = await httpFetch(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      } catch (error) {
        throw new Error(describeFetchError(options.label, error))
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `${options.label} model list returned ${response.status}: ${
            detail.slice(0, 200) || response.statusText
          }`,
        )
      }
      const json = (await response.json()) as {
        data?: Array<{ id?: string }>
      }
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort()
    },
    async complete(input: CompleteInput): Promise<string> {
      const body = {
        model: input.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        max_tokens: input.maxTokens ?? 2048,
        temperature: input.temperature ?? 0.1,
        stream: false,
      }
      let response: Response
      try {
        response = await httpFetch(options.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${input.apiKey}`,
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        })
      } catch (error) {
        throw new Error(describeFetchError(options.label, error))
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `${options.label} returned ${response.status}: ${
            detail.slice(0, 300) || response.statusText
          }`,
        )
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error(`${options.label} returned an unexpected response shape.`)
      }
      return content
    },
  }
}