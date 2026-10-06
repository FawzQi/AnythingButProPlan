import type { AiProviderId, SuggestMethod } from "./ai";

export type AppMode = "coding" | "research";

export interface RecentFolder {
  /** Absolute path to the folder, as the native picker returned it. */
  path: string;
  /** Display label. Defaults to the folder's basename. */
  label: string;
  /** Unix milliseconds of the last time this folder was opened. */
  lastOpenedAt: number;
}

export interface AiSettings {
  provider: AiProviderId | null;
  /** Chosen model per provider. Missing entry means "use the provider default". */
  modelByProvider: Partial<Record<AiProviderId, string>>;
  /** True when a key has been saved for this provider. */
  hasApiKey: Partial<Record<AiProviderId, boolean>>;
  /** Which file-suggestion pipeline the "Suggest files" button runs. */
  suggestMethod: SuggestMethod;
  /** Coding mode or research mode — see `AppMode`. */
  mode: AppMode;
  /**
   * When true, applies Stage-1 HyDE AI query expansion to all file suggestion
   * methods.
   */
  enableHydeQuery: boolean;
  /** Provider used for HyDE query expansion. */
  hydeProvider: AiProviderId;
  /** Model used for HyDE query expansion. */
  hydeModel: string;
}

export interface AiSettingsSaveRequest {
  provider?: AiProviderId | null;
  /** Set or replace the model for one provider. */
  model?: { provider: AiProviderId; model: string };
  /** Set or replace the API key for one provider. Empty string clears it. */
  apiKey?: { provider: AiProviderId; key: string };
  /** Switch the file-suggestion pipeline. */
  suggestMethod?: SuggestMethod;
  /** Switch between coding mode and research mode. */
  mode?: AppMode;
  /** Enable or disable HyDE AI query expansion across suggestion methods. */
  enableHydeQuery?: boolean;
  /** Update HyDE provider. */
  hydeProvider?: AiProviderId;
  /** Update HyDE model. */
  hydeModel?: string;
}
