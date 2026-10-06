import type { AiProviderId } from '@shared/types'
import type { AiProvider, CompleteInput, VisionInput } from './types'
import { describeFetchError, httpFetch } from './http'

/**
 * Whether a model is one whose response includes a separate thinking phase
 * billed against the same `max_tokens` budget as the final answer.
 *
 * This matters because the failure is silent. A reasoning model given a
 * budget sized for a chat model (1024–2048 tokens) spends the entire
 * allocation thinking, then returns `content: ""`. Downstream JSON parsing
 * sees an empty string, produces an empty `files` array, and the UI shows
 * "0 file(s) selected" — with no error anywhere in the chain. From the
 * user's seat this is indistinguishable from the model refusing to answer,
 * and it is why a DeepSeek reasoner appears to work only sometimes: short
 * instructions finish thinking before the budget runs out, longer ones do
 * not.
 *
 * The list is deliberately conservative. A false positive is harmless (a
 * larger budget than strictly needed); a false negative silently produces
 * empty results, which is the exact bug being fixed.
 */
function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase()
  // DeepSeek: everything except `deepseek-chat` currently ships a thinking
  // phase. This covers `deepseek-reasoner` and the `v4-*` family.
  if (lower.startsWith('deepseek') && !lower.startsWith('deepseek-chat')) {
    return true
  }
  // OpenAI o-series and GPT-5.
  if (/^o[1-9]\b/.test(lower) || lower.startsWith('gpt-5')) return true
  // Gemini 2.5 and 3 think by default.
  if (/gemini-[23]/.test(lower)) return true
  // Generic naming hints used by several open-weight models.
  return /(?:^|[-/])(?:reasoner|reasoning|thinking|qwq|glm-z1)(?:$|[-/])/.test(
    lower,
  )
}

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
      // Reasoning models bill their thinking phase against `max_tokens`. A
      // budget sized for a chat model is spent entirely on reasoning,
      // leaving `content` empty. Scale the budget up for models that are
      // known to think before answering.
      const requested = input.maxTokens ?? 2048
      const maxTokens = isReasoningModel(input.model)
        ? Math.max(requested * 4, 8192)
        : requested

      const body = {
        model: input.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        max_tokens: maxTokens,
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
        choices?: Array<{
          message?: {
            content?: string
            reasoning_content?: string
          }
          finish_reason?: string
        }>
      }
      const choice = json.choices?.[0]
      const content = choice?.message?.content

      // A truncated response is the other half of the reasoning-token trap:
      // the model ran out of budget mid-thought. Surface it as an error
      // rather than letting the caller parse an empty string.
      if (choice?.finish_reason === 'length') {
        throw new Error(
          `${options.label} ran out of tokens before producing a final answer. ` +
            `This usually means the model's reasoning phase consumed the entire ` +
            `budget. Try a shorter instruction, or switch to a model with a ` +
            `smaller thinking footprint (e.g. deepseek-chat).`,
        )
      }

      if (typeof content !== 'string' || content === '') {
        // Reasoning models occasionally return an empty `content` with a
        // populated `reasoning_content` — the thinking happened but the
        // final answer never arrived. Report that shape specifically so the
        // user knows the model did respond, just not usefully.
        const reasoning = choice?.message?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.trim() !== '') {
          throw new Error(
            `${options.label} produced only reasoning output with no final ` +
              `answer. Try rephrasing the instruction, or switch to a ` +
              `non-reasoning model.`,
          )
        }
        throw new Error(`${options.label} returned an empty response.`)
      }
      return content
    },
    /**
     * Vision on the OpenAI shape: the user message's `content` becomes an
     * array of parts, one `text` part for the instruction and one
     * `image_url` part per image, each holding a base64 data URI.
     *
     * `detail: 'high'` is set explicitly. The default is `auto`, which lets
     * the vendor downscale — and a downscaled chart axis is exactly the
     * content this pass exists to read.
     */
    async completeVision(input: VisionInput): Promise<string> {
      const requested = input.maxTokens ?? 1024
      const maxTokens = isReasoningModel(input.model)
        ? Math.max(requested * 4, 4096)
        : requested

      const body = {
        model: input.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              ...input.images.map((image) => ({
                type: 'image_url',
                image_url: {
                  url: `data:${image.mimeType};base64,${image.base64}`,
                  detail: 'high',
                },
              })),
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
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
        throw new Error(describeFetchError(options.label, error), {
          cause: error,
        })
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
      if (typeof content !== 'string' || content === '') {
        throw new Error(
          `${options.label} returned no description for the image batch. ` +
            `If this model does not accept images, pick a vision model in the conversion panel.`,
        )
      }
      return content
    },
  }
}