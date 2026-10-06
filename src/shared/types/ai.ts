export type AiProviderId =
  | "deepseek"
  | "groq"
  | "openai"
  | "openrouter"
  | "google"
  | "typesafe";

export type SuggestMethod = "gitnexus-only" | "gitnexus-jev" | "gitnexus-llm";

export interface AiProviderInfo {
  id: AiProviderId;
  /** Human-readable name for the settings UI. */
  label: string;
  /** Where the user gets an API key. Shown as a link. */
  keyUrl: string;
  /** Models the provider exposes. First entry is the default. */
  models: string[];
}

export interface AiSuggestRequest {
  projectRoot: string;
  /** Every file path in the scanned tree — the AI may only pick from these. */
  filePaths: string[];
  /** The user's "Additional instructions" text — the feature request. */
  instruction: string;
  /** When true, bypasses the LLM and only computes the codebase map tokens. */
  dryRun?: boolean;
}

export interface AiSuggestion {
  /** Validated paths the AI picked, in the order it returned them. */
  paths: string[];
  /** Brief explanation of why each file was selected, keyed by path. */
  purposes: Record<string, string>;
  provider: AiProviderId;
  model: string;
  /** Approximate tokens in the skeleton map that was sent. */
  mapTokens: number;
  /** Approximate tokens in the AI response. */
  outputTokens: number;
  /** Wall-clock duration of the API call, milliseconds. */
  durationMs: number;
  /**
   * Paths the AI returned that do not exist in the scanned tree.
   */
  hallucinated: string[];
  /** Which pipeline produced this suggestion. */
  method?: SuggestMethod;
  /**
   * Tokens consumed by the stage-1 keyword expansion call.
   */
  stage1Tokens?: number;
  /**
   * How many candidates survived hybrid search + reranking.
   */
  candidateCount?: number;
  /**
   * True when the GitNexus method was selected but the `gitnexus` CLI was
   * not found on PATH.
   */
  gitnexusMissing?: boolean;

  /**
   * Per-file Jev relevance score (0–3) keyed by path.
   */
  jevScores?: Record<string, number>;
  /**
   * Per-file Jev confidence (0–1) keyed by path.
   */
  jevConfidence?: Record<string, number>;
  /**
   * Paths Jev scored 3 with high confidence.
   */
  jevIncluded?: string[];
  /**
   * Paths Jev scored 2.
   */
  jevFlagged?: string[];
  /**
   * Paths Jev scored 0 or 1.
   */
  jevDropped?: string[];
  /** Number of Jev API calls made. */
  jevBatchCount?: number;
  /** Input tokens billed by Jev. */
  jevTokens?: number;
}
