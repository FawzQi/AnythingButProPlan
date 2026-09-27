import type { AiProviderId } from './types'

/**
 * Vision provider catalogue for the per-conversion picker.
 *
 * This lives in `shared/` because both sides need it: the renderer renders
 * the picker, and the main process validates that the provider the renderer
 * sent is one of these — the renderer is not a trust boundary, so a provider
 * id arriving over IPC is checked against this list rather than trusted.
 *
 * The order is a cost decision, not a capability list. DeepSeek Flash is
 * first because it is the cheapest model that reads figures well; the others
 * are close enough on quality that price and quota decide.
 *
 * Deliberately not a global setting: the provider is chosen per conversion
 * and recorded in the document's `meta.json`, so a re-run stays consistent
 * with what the stored descriptions were produced by. See CLAUDE.md.
 */
export interface VisionProviderOption {
  id: AiProviderId
  label: string
  /** Model id this option calls. */
  model: string
  /** One line for the picker's help text. */
  note: string
}

export const VISION_PROVIDERS: VisionProviderOption[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek Flash',
    model: 'deepseek-flash',
    note: 'Cheapest that reads figures accurately — the default.',
  },
  {
    id: 'google',
    label: 'Google AI Studio',
    model: 'gemini-3.5-flash',
    note: 'Free tier available; strongest at charts and tables.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    model: 'inclusionai/ling-3.0-flash-vl:free',
    note: 'Fallback when the other two are out of quota.',
  },
  {
    id: 'groq',
    label: 'Groq',
    model: 'llama-3.3-70b-versatile',
    note: 'Fast, but the weakest of the four at dense figures.',
  },
]

export const DEFAULT_VISION_PROVIDER: AiProviderId = 'deepseek'

export function visionProviderOption(
  id: AiProviderId | undefined,
): VisionProviderOption {
  return (
    VISION_PROVIDERS.find((option) => option.id === id) ?? VISION_PROVIDERS[0]!
  )
}
