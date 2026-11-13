/**
 * Guards between a parsed response and the applier.
 *
 * Everything here answers one question: could writing this response damage
 * the repository in a way the model did not intend? Three failure modes are
 * common enough to be worth naming:
 *
 *   1. **Truncation** — the chat UI or the token limit cut the response off.
 *      The parse "succeeds" with half a file.
 *   2. **Size collapse** — the response is complete but far smaller than the
 *      file it replaces, usually because the model summarized instead of
 *      reproducing.
 *   3. **Stale content** — the file changed on disk after the prompt was
 *      built, so the model's SEARCH blocks no longer match or, worse, match
 *      the wrong region.
 *
 * A guard that fires produces a *repair request* — a short instruction the
 * user can paste back — rather than discarding the whole turn.
 */
import { createHash } from "node:crypto";
import type { ParsedFile, TurnPrompt } from "@shared/types";

export type GuardIssueKind = "truncated" | "size-collapse" | "stale" | "empty";

export interface GuardIssue {
  kind: GuardIssueKind;
  path: string | null;
  message: string;
  /** Short text the user can paste back to get a usable response. */
  repair: string;
}

export interface GuardInput {
  files: ParsedFile[];
  /** Current on-disk content by path, for staleness and size comparison. */
  diskContent: Map<string, string>;
  /** The prompt that produced this response, when available. */
  prompt?: TurnPrompt;
}

/** A full rewrite smaller than this fraction of the original is suspect. */
const COLLAPSE_FRACTION = 0.4;
/** Below this many lines, a big shrink can be legitimate. */
const COLLAPSE_MIN_LINES = 40;

function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/**
 * Check every parsed file and return the issues found.
 */
export function inspectFiles(input: GuardInput): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const file of input.files) {
    if (file.path === null) continue;

    if (file.truncated === true) {
      issues.push({
        kind: "truncated",
        path: file.path,
        message: `${file.path} was cut off — the code block never closed.`,
        repair: `Your response for ${file.path} was cut off before the closing code fence. Resend only that file, complete, in a single fenced block.`,
      });
      continue;
    }

    const disk = input.diskContent.get(file.path);
    if (disk === undefined) continue;

    if (file.kind === "full") {
      const originalLines = lineCount(disk);
      const proposedLines = lineCount(file.content);
      if (
        originalLines >= COLLAPSE_MIN_LINES &&
        proposedLines / originalLines < COLLAPSE_FRACTION
      ) {
        issues.push({
          kind: "size-collapse",
          path: file.path,
          message: `${file.path}: ${proposedLines} lines proposed, ${originalLines} on disk.`,
          repair: `The rewrite of ${file.path} is far shorter than the current file (${proposedLines} vs ${originalLines} lines), which usually means it was cut off. Resend the complete file, or use a SEARCH/REPLACE patch for just the change.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Nonce check: the response must belong to the turn that is currently waiting.
 * The nonce is embedded in the prompt, and a model that copies its instructions
 * back will carry it along; a response pasted from an older turn will not.
 */
export function matchesTurnNonce(response: string, nonce: string): boolean {
  return response.includes(nonce);
}

/**
 * Detect a file that changed since the prompt was built.
 *
 * Only meaningful when the prompt recorded the content hash; older prompts do
 * not, and skipping the check is correct rather than treating absence as a
 * conflict.
 */
export function detectStaleContent(
  promptHashes: Map<string, string>,
  diskContent: Map<string, string>,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const [filePath, expected] of promptHashes) {
    const disk = diskContent.get(filePath);
    if (disk === undefined) continue;
    const actual = contentHash(disk);
    if (actual === expected) continue;
    issues.push({
      kind: "stale",
      path: filePath,
      message: `${filePath} changed on disk after the prompt was built.`,
      repair: `The file ${filePath} changed after this prompt was generated, so its SEARCH blocks may not match. Ask the user to rebuild the turn, or emit the whole file instead of a patch.`,
    });
  }
  return issues;
}

/** True when at least one issue must block a write. */
export function blocksApply(issues: GuardIssue[]): boolean {
  return issues.some(
    (issue) => issue.kind === "truncated" || issue.kind === "size-collapse" || issue.kind === "stale",
  );
}

/** Collapse issues into one paste-ready repair prompt. */
export function repairPrompt(issues: GuardIssue[]): string {
  return [
    "Your previous response could not be applied safely.",
    "",
    ...issues.map((issue) => `- ${issue.message}`),
    "",
    "Fix only the problems above and resend the affected files. Do not repeat files that were fine.",
  ].join("\n");
}
