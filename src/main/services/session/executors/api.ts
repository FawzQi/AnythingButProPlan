/**
 * Direct-API executor — the optional unattended mode.
 *
 * Wraps the existing provider `complete()` call. It shares the whole loop with
 * the clipboard path: same prompt, same parser, same applier, same verifier.
 * The only difference is where the response text comes from, which is why the
 * two modes cannot drift apart.
 */
import { getProvider } from "../../ai/ai-providers";
import type {
  ApiExecutorOptions,
  TurnExecutor,
  TurnRequest,
  TurnResponse,
} from "./types";
import { ExecutorCancelledError } from "./types";

export class ApiExecutor implements TurnExecutor {
  readonly kind = "api" as const;
  private cancelled = false;

  constructor(private readonly options: ApiExecutorOptions) {}

  async execute(request: TurnRequest): Promise<TurnResponse> {
    this.cancelled = false;
    const provider = getProvider(this.options.providerId);

    const text = await provider.complete({
      apiKey: this.options.apiKey,
      model: this.options.model,
      system: this.options.system ?? "You are an expert software engineer editing a local repository.",
      user: request.prompt,
      maxTokens: this.options.maxTokens ?? 8192,
    });

    // Cancellation is checked after the await: providers do not expose an
    // abort signal, so the turn finishes in the background and its result is
    // discarded rather than applied.
    if (this.cancelled) throw new ExecutorCancelledError();

    this.options.onChunk?.(text);
    return { text, source: "api" };
  }

  cancel(): void {
    this.cancelled = true;
  }
}
