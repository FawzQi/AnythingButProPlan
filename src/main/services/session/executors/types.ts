/**
 * The seam between the session state machine and however the response is
 * actually obtained.
 *
 * `ClipboardExecutor` is the copy-paste path: it hands the prompt to the UI and
 * the turn resolves when the user pastes a response back.
 *
 * `ApiExecutor` is the optional unattended path: it calls the configured
 * provider directly.
 *
 * Keeping both behind one interface is the point of the design — the loop,
 * the verifier, and the applier are identical either way, so the two paths
 * cannot drift.
 */
import type { AiProviderId } from "@shared/types";

export interface TurnRequest {
  prompt: string;
  /**
   * Turn-scoped nonce. Embedded in the prompt so a response pasted from the
   * wrong turn can be rejected instead of applied to the wrong files.
   */
  nonce: string;
}

export interface TurnResponse {
  text: string;
  /** Which executor produced it. */
  source: "clipboard" | "api";
}

export interface TurnExecutor {
  readonly kind: "clipboard" | "api";
  /** Emit the prompt and resolve when a response is available. */
  execute(request: TurnRequest): Promise<TurnResponse>;
  /** Abandon any in-flight turn. Safe to call when idle. */
  cancel(): void;
}

export interface ApiExecutorOptions {
  providerId: AiProviderId;
  apiKey: string;
  model: string;
  /** System message sent alongside the user prompt. */
  system?: string;
  maxTokens?: number;
  /** Called with streamed text, when the provider supports it. */
  onChunk?: (text: string) => void;
}

export class ExecutorCancelledError extends Error {
  constructor() {
    super("The turn was cancelled.");
    this.name = "ExecutorCancelledError";
  }
}
