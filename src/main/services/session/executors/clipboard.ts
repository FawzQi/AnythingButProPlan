/**
 * Copy-paste executor.
 *
 * This is not a stub: it is the primary path for the app. The prompt is
 * delivered to the UI (which copies it to the clipboard), and the turn stays
 * pending until the user pastes a response. The engine treats the wait as a
 * normal state, not an error, and the pending turn is persisted so an app
 * restart resumes the same wait.
 */
import { randomBytes } from "node:crypto";
import type { TurnExecutor, TurnRequest, TurnResponse } from "./types";
import { ExecutorCancelledError } from "./types";

type Resolver = (response: TurnResponse) => void;
type Rejecter = (error: Error) => void;

export class ClipboardExecutor implements TurnExecutor {
  readonly kind = "clipboard" as const;

  private pending:
    | { nonce: string; resolve: Resolver; reject: Rejecter }
    | null = null;

  /** Called with the prompt when a turn is emitted, so the UI can show it. */
  constructor(private readonly onEmit: (request: TurnRequest) => void) {}

  execute(request: TurnRequest): Promise<TurnResponse> {
    // One in-flight turn at a time. A second `execute` means the caller lost
    // track of the first one, which would otherwise leave a promise pending
    // forever.
    this.cancel();
    return new Promise<TurnResponse>((resolve, reject) => {
      this.pending = { nonce: request.nonce, resolve, reject };
      this.onEmit(request);
    });
  }

  /**
   * Deliver a pasted response. Returns false when nothing is waiting or the
   * nonce does not match — a response for the wrong turn must never be
   * applied.
   */
  deliver(text: string, nonce: string): boolean {
    const pending = this.pending;
    if (pending === null || pending.nonce !== nonce) return false;
    this.pending = null;
    pending.resolve({ text, source: "clipboard" });
    return true;
  }

  /** The nonce of the turn currently waiting, or null. */
  get pendingNonce(): string | null {
    return this.pending?.nonce ?? null;
  }

  cancel(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    pending.reject(new ExecutorCancelledError());
  }
}

/** A per-turn nonce, short enough to read but not guessable from another turn. */
export function newTurnNonce(): string {
  return randomBytes(4).toString("hex");
}
