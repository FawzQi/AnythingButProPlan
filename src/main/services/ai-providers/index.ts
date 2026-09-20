import type { AiProviderId, AiProviderInfo } from '@shared/types'
import { makeOpenAiCompatibleProvider } from './openai-compatible'
import { googleProvider } from './google'
import type { AiProvider } from './types'

const deepseek = makeOpenAiCompatibleProvider({
  id: 'deepseek',
  label: 'DeepSeek',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  baseUrl: 'https://api.deepseek.com/chat/completions',
})

const groq = makeOpenAiCompatibleProvider({
  id: 'groq',
  label: 'Groq',
  keyUrl: 'https://console.groq.com/keys',
  models: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
  ],
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
})

const openrouter = makeOpenAiCompatibleProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  keyUrl: 'https://openrouter.ai/keys',
  models: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-flash-1.5-8b',
    'qwen/qwen-2.5-72b-instruct',
    'deepseek/deepseek-v4-flash-0731:free'
  ],
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  // OpenRouter attributes requests to a caller via these headers. They are
  // optional but help with rate-limit accounting on the free tier.
  extraHeaders: {
    'HTTP-Referer': 'https://github.com/larpgent/larpgent',
    'X-Title': 'LARPGent',
  },
})

const PROVIDERS: Record<AiProviderId, AiProvider> = {
  deepseek,
  groq,
  openrouter,
  google: googleProvider,
}

export function getProvider(id: AiProviderId): AiProvider {
  return PROVIDERS[id]
}

export function listProviders(): AiProviderInfo[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    keyUrl: p.keyUrl,
    models: p.models,
  }))
}

/**
 * Fetch the live model catalogue for a provider using the caller's API key.
 * Falls back to the provider's seed list when the provider does not expose
 * a list endpoint. Called from the main process only — the key never reaches
 * the renderer.
 */
export async function discoverModels(
  id: AiProviderId,
  apiKey: string,
): Promise<string[]> {
  const provider = PROVIDERS[id]
  if (!provider.listModels) return [...provider.models]
  return provider.listModels(apiKey)
}