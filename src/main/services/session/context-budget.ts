/**
 * Token accounting for a turn prompt.
 *
 * The app must never send a prompt the web chat will silently truncate. That
 * means a hard budget, a deterministic inclusion order, and an explicit
 * manifest of what was left out — so the model can ask for a missing file
 * with `===Need===` instead of guessing at its contents.
 *
 * Order of inclusion (first wins, later ones fill remaining space):
 *   1. Files the model explicitly requested (`===Need===`)
 *   2. Files changed since the last turn
 *   3. Files named in the current plan step
 *   4. Recall hits seeded by the task and any failing test names
 *   5. Skeleton-only entries for everything else that matters
 */
import type { FileNode } from "@shared/types";

/** Rough characters-per-token for code. Deliberately pessimistic. */
const CHARS_PER_TOKEN = 3.2;

/** Per-file share of the budget, so one huge file cannot starve the rest. */
const PER_FILE_FRACTION = 0.45;

/** Skeleton entries are capped separately; they are cheap but not free. */
const SKELETON_BUDGET_FRACTION = 0.15;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetFile {
  path: string;
  content: string;
  /** Line count on disk, for the manifest. */
  lines: number;
}

export interface SkippedFile {
  path: string;
  lines: number;
  reason: "budget" | "unreadable" | "binary" | "too-large";
}

export interface BudgetResult {
  included: BudgetFile[];
  /** Skeleton lines for files that were reduced rather than dropped. */
  skeletons: { path: string; skeleton: string }[];
  /** Files the model was told about but not given. */
  omitted: SkippedFile[];
  tokensUsed: number;
  budget: number;
}

export interface BudgetCandidate {
  path: string;
  content: string;
  skeleton?: string;
  /** Lower is more important. Ties break on path for determinism. */
  priority: number;
  /** When true the file is included whole or not at all (e.g. requested). */
  mustInclude?: boolean;
}

/**
 * Fit candidates into a token budget.
 *
 * Deterministic for the same input: sorting is by `(priority, path)`, so two
 * runs produce byte-identical prompts. That matters because the prompt is
 * shown to the user and re-pasted between turns.
 */
export function fitToBudget(
  candidates: BudgetCandidate[],
  budget: number,
): BudgetResult {
  const perFileCap = Math.max(1, Math.floor(budget * PER_FILE_FRACTION));
  const skeletonCap = Math.max(0, Math.floor(budget * SKELETON_BUDGET_FRACTION));

  const ordered = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.path.localeCompare(b.path),
  );

  const included: BudgetFile[] = [];
  const skeletons: { path: string; skeleton: string }[] = [];
  const omitted: SkippedFile[] = [];
  let tokensUsed = 0;
  let skeletonTokens = 0;

  for (const candidate of ordered) {
    const lines = candidate.content.split("\n").length;
    const fileTokens = estimateTokens(candidate.content);

    if (fileTokens <= perFileCap && tokensUsed + fileTokens <= budget) {
      included.push({ path: candidate.path, content: candidate.content, lines });
      tokensUsed += fileTokens;
      continue;
    }

    // Too big or not enough room: try the skeleton.
    if (candidate.skeleton !== undefined && skeletonTokens + estimateTokens(candidate.skeleton) <= skeletonCap) {
      skeletons.push({ path: candidate.path, skeleton: candidate.skeleton });
      skeletonTokens += estimateTokens(candidate.skeleton);
      continue;
    }

    omitted.push({
      path: candidate.path,
      lines,
      reason: "budget",
    });
  }

  return {
    included,
    skeletons,
    omitted,
    tokensUsed: tokensUsed + skeletonTokens,
    budget,
  };
}

/** Every file path in a scanned tree, sorted for determinism. */
export function collectPaths(tree: FileNode | null): string[] {
  const paths: string[] = [];
  const walk = (node: FileNode): void => {
    if (node.type === "file") paths.push(node.path);
    for (const child of node.children ?? []) walk(child);
  };
  if (tree !== null) walk(tree);
  return paths.sort((a, b) => a.localeCompare(b));
}
