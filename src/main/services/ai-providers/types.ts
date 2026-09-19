import type { AiProviderId } from '@shared/types'

export interface CompleteInput {
  apiKey: string
  model: string
  system: string
  user: string
  maxTokens?: number
  temperature?: number
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
}