/**
 * Folds a long turn history into durable state so the prompt stays bounded.
 *
 * What survives compaction:
 *   - the task (always)
 *   - the plan (always)
 *   - decisions: durable facts learned along the way
 *   - the failure ledger: one line per failed attempt, so the model does not
 *     retry the same broken approach
 *
 * What does not survive: the verbatim prompt and response of old turns. Those
 * are the bulk of the bytes and the least useful after the fact.
 *
 * Compaction is deterministic: the same session always produces the same
 * compacted form, so a rebuilt prompt matches what the user saw.
 */
import type { Session, Turn } from "@shared/types";

/** Turns kept verbatim before compaction kicks in. */
export const KEEP_RECENT_TURNS = 6;

export interface CompactionResult {
  session: Session;
  compacted: boolean;
  /** Number of turns folded away. */
  foldedTurns: number;
}

function describeTurn(turn: Turn): string | null {
  if (turn.outcome === "regressed") {
    return `Turn ${turn.index}: ${turn.regression ?? "regressed and was rolled back"}`;
  }
  if (turn.outcome === "failed") {
    const failures = turn.verification
      ?.flatMap((result) => result.failures.map((failure) => failure.message))
      .slice(0, 2)
      .join("; ");
    return `Turn ${turn.index}: failed${failures ? ` — ${failures}` : ""}`;
  }
  if (turn.outcome === "needed-context") {
    const needs = turn.parsed?.needs ?? [];
    return `Turn ${turn.index}: requested ${needs.length} file(s)`;
  }
  if (turn.outcome === "rejected") {
    return `Turn ${turn.index}: changes rejected, nothing applied`;
  }
  return null;
}

/**
 * Fold old turns into `decisions`. Idempotent: running it twice produces the
 * same session.
 */
export function compactSession(session: Session): CompactionResult {
  if (session.turns.length <= KEEP_RECENT_TURNS) {
    return { session, compacted: false, foldedTurns: 0 };
  }

  const cutoff = session.turns.length - KEEP_RECENT_TURNS;
  const oldTurns = session.turns.slice(0, cutoff);
  const recentTurns = session.turns.slice(cutoff);

  const newLedger = oldTurns
    .map(describeTurn)
    .filter((line): line is string => line !== null);

  const existing = new Set(session.decisions);
  const ledgerPrefix = "history: ";
  const decisions = [
    ...session.decisions.filter((entry) => !entry.startsWith(ledgerPrefix)),
    ...newLedger
      .filter((line) => !existing.has(ledgerPrefix + line))
      .map((line) => ledgerPrefix + line),
  ];

  return {
    compacted: true,
    foldedTurns: oldTurns.length,
    session: {
      ...session,
      turns: recentTurns.map((turn, index) => ({ ...turn, index: index + 1 })),
      decisions,
      updatedAt: Date.now(),
    },
  };
}

/** True when compaction would do something. */
export function needsCompaction(session: Session): boolean {
  return session.turns.length > KEEP_RECENT_TURNS;
}
