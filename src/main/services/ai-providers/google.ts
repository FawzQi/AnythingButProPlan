import type { AiProvider, CompleteInput } from './types'
import { describeFetchError, httpFetch } from './http'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * Google AI Studio uses a different shape from the OpenAI-compatible
 * vendors: `systemInstruction` rather than a system message, `contents`
 * rather than `messages`, and the API key travels in the query string.
 * Everything else — text in, text out — is the same.
 *
 * Model names on this endpoint rotate on Google's own schedule, and a name
 * that worked a month ago can start returning 404 `model ... is not found
 * for API version v1beta` for new users. When that happens, replace the
 * entries below with names from the live catalogue:
 *
 *   curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY" \
 *     | jq -r '.models[] | select(.supportedGenerationMethods | index("generateContent")) | .name'
 *
 * The names below are the current stable entries; the older `gemini-1.5-*`
 * family has been retired from this endpoint.
 *
 * Requests go through `httpFetch` (Chromium's network stack) rather than
 * the global `fetch`, which is what makes proxy and dual-stack network
 * setups work. See `http.ts` for the reasoning.
 */
export const googleProvider: AiProvider = {
  id: 'google',
  label: 'Google AI Studio',
  keyUrl: 'https://aistudio.google.com/apikey',
  models: ['gemini-2.0-flash-lite', 'gemini-2.0-flash'],
  async complete(input: CompleteInput): Promise<string> {
    const url = `${BASE}/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: 'user', parts: [{ text: input.user }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 2048,
        temperature: input.temperature ?? 0.1,
      },
    }
    let response: Response
    try {
      response = await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new Error(describeFetchError('Google AI Studio', error))
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Google AI Studio returned ${response.status}: ${
          detail.slice(0, 300) || response.statusText
        }`,
      )
    }
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string') {
      throw new Error('Google AI Studio returned an unexpected response shape.')
    }
    return text
  },
}