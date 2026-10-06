import type { AiProviderId } from '@shared/types'

export interface CompleteInput {
  apiKey: string
  model: string
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

export interface VisionInput {
  apiKey: string
  model: string
  /** Instruction for the model; the images travel alongside it. */
  prompt: string
  /**
   * Base64 payloads, no data-URI prefix. Callers read the bytes and hand
   * them over — the provider is the only layer that knows whether its wire
   * format wants `inlineData` or a `data:` URL, and neither should be
   * assembled anywhere else.
   */
  images: { mimeType: string; base64: string }[]
  maxTokens?: number
}

export interface EmbedInput {
  apiKey: string
  model: string
  /** Texts to embed, in order. The result is aligned with this array. */
  texts: string[]
}

export interface AiProvider {
  id: AiProviderId
  label: string
  /** Where the user goes to mint an API key. Shown in Settings. */
  keyUrl: string
  /**
   * Seed list shown in the model picker before the live catalogue has loaded,
   * and the fallback if the live call fails. Vendors retire model names on
   * their own schedule — Google especially — so this list is a starting
   * point, not a source of truth. `listModels` below is the source of truth.
   */
  models: string[]
  /** Returns the assistant's text content, or throws with a user-readable message. */
  complete(input: CompleteInput): Promise<string>
  /**
   * Fetch the current model catalogue for this provider using the user's key.
   * Vendors rotate names without warning; calling this is the only way to
   * stay ahead of a 404 like `models/gemini-X.Y-flash is not found`. Optional
   * because not every vendor exposes an equivalent endpoint.
   */
  listModels?(apiKey: string): Promise<string[]>
  /**
   * Describe one or more images alongside a text prompt. Implemented by the
   * providers that accept images on their chat endpoint; absent everywhere
   * else, which is why the research mode's figure pass checks for it before
   * offering a provider in the picker.
   */
  completeVision?(input: VisionInput): Promise<string>
  /**
   * Embed a batch of texts. Google is the only provider here with an
   * embedding endpoint, and research mode deliberately does not grow a
   * second one: switching embedding models invalidates every stored vector,
   * so a second provider would mean a full re-embed of the corpus for no
   * user-visible gain at the 20–200 document scale this app targets.
   */
  embed?(input: EmbedInput): Promise<number[][]>
}