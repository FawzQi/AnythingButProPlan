/**
 * Builds the per-turn prompt for a coding session.
 *
 * The prompt is the entire interface between the app and the web chat, so it
 * has to carry everything the chat cannot know: the task, the plan, the
 * current failure, the files, and what was deliberately left out.
 */
import type {
  PlanStep,
  Session,
  Turn,
  TurnPrompt,
  VerificationResult,
} from "@shared/types";
import { createHash } from "node:crypto";
import { estimateTokens } from "./context-budget";

/** Short content hash shown beside each file header. */
function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

export interface TurnContext {
  /** Files included verbatim, already budgeted. */
  files: { path: string; content: string; lines: number }[];
  /** Skeleton-only entries for files that did not fit. */
  skeletons: { path: string; skeleton: string }[];
  /** Files known but not shown. Listed so the model can ask for them. */
  omitted: { path: string; lines: number }[];
  /** Verification output from the previous turn, errors first. */
  verification: VerificationResult[];
  /** Paths applied on the previous turn. */
  applied: string[];
}

function planLine(step: PlanStep, index: number): string {
  const box =
    step.status === "done"
      ? "[x]"
      : step.status === "active"
        ? "[>]"
        : step.status === "blocked"
          ? "[!]"
          : "[ ]";
  return `${box} ${index + 1}. ${step.text}`;
}

function fence(content: string): string {
  // The fence must be longer than any backtick run in the content, or the
  // block terminates early and the model sees mangled code.
  const longest = Math.max(
    2,
    ...(content.match(/`{3,}/g) ?? []).map((run) => run.length),
  );
  const marker = "`".repeat(longest + 1);
  return `${marker}\n${content}\n${marker}`;
}

function verificationBlock(results: VerificationResult[]): string {
  if (results.length === 0) return "No verification has run yet.";
  return results
    .map((result) => {
      const header = `${result.stage} (\`${result.command}\`) — ${result.success ? "PASSED" : "FAILED"}`;
      if (result.success) return header;
      const failures =
        result.failures.length > 0
          ? result.failures
              .slice(0, 25)
              .map((failure) => {
                const where = [failure.file, failure.line].filter(Boolean).join(":");
                return `- ${where}${failure.test ? ` ${failure.test}` : ""}: ${failure.message}`;
              })
              .join("\n")
          : result.output.split("\n").slice(-40).join("\n");
      return `${header}\n${failures}`;
    })
    .join("\n\n");
}

const OUTPUT_CONTRACT = `## Output contract

Reply with these sections, in this order, and nothing else.

===Plan===
- [x] completed step
- [>] step in progress
- [ ] not started
======

===Need===
<project-relative paths you must read before you can make this change, one per
line, or the single word None>
======

===Files===
<file entries, as described below>
======

===Explanation===
<what you changed and why, or None>
======

===Debug===
<commands the user should run to verify, in a bash block, or None>
======

A section terminator is exactly six \`=\` on its own line. The SEARCH/REPLACE
separator inside a patch is seven.

### ===Need===

Ask for a file only when you cannot make a correct edit without seeing its
current contents. The app fetches what you ask for and sends it in the next
turn. Asking costs one round trip; guessing costs a wrong edit that has to be
reverted.

Do not ask for a file that is already shown above. Do not ask for a directory.
Do not ask for a file just to confirm something you can infer from its
skeleton.

### ===Files===

Emit every file you change. Two forms:

**Full file** — a \`File: <path>\` line, then a fenced block with the file's
complete contents. Use this for new files, for rewrites, and whenever the change
touches more than a handful of lines.

**Patch** — a \`File: <path>\` line, then one or more SEARCH/REPLACE pairs:

    <<<<<<< SEARCH
    (exact text copied from the file above)
    =======
    (replacement text)
    >>>>>>> REPLACE

Use a patch only for a surgical change where the exact surrounding text is
visible above. The SEARCH block must be a character-exact substring, including
whitespace.

**Delete** — a \`Delete: <path>\` line in the prose between entries, never inside
a fenced block.

### Hard rules

- Change only what the task asks for. No opportunistic refactors.
- If a file is unchanged, do not include it.
- Never emit a file you have not been shown in full or asked to create.
- Prefer the full-file form whenever in doubt; a patch that fails to match is
  always broken, while a slightly long full file is always correct.`;

/**
 * Assemble the prompt for the next turn.
 */
export function buildTurnPrompt(
  session: Session,
  turnIndex: number,
  context: TurnContext,
  nonce: string,
): TurnPrompt {
  const sections: string[] = [];

  sections.push(`# Coding session — turn ${turnIndex}`);
  sections.push(`## Task\n\n${session.task}`);

  if (session.plan.length > 0) {
    sections.push(`## Plan\n\n${session.plan.map(planLine).join("\n")}`);
  }

  if (session.decisions.length > 0) {
    sections.push(
      `## Project facts\n\n${session.decisions.map((fact) => `- ${fact}`).join("\n")}`,
    );
  }

  const sinceLastTurn: string[] = [];
  if (context.applied.length > 0) {
    sinceLastTurn.push(`- applied: ${context.applied.join(", ")}`);
  }
  if (context.verification.length > 0) {
    const failed = context.verification.filter((result) => !result.success);
    sinceLastTurn.push(
      failed.length === 0
        ? "- verification: all stages passed"
        : `- verification: ${failed.map((result) => result.stage).join(", ")} FAILED`,
    );
  }
  if (sinceLastTurn.length > 0) {
    sections.push(`## Since the last turn\n\n${sinceLastTurn.join("\n")}`);
  }

  if (context.files.length > 0) {
    const rendered = context.files
      .map(
        (file) =>
          `### ${file.path} · ${file.lines} lines · sha ${contentHash(file.content)}\n\n${fence(file.content)}`,
      )
      .join("\n\n");
    sections.push(`## Files — current on-disk content\n\n${rendered}`);
  }

  if (context.skeletons.length > 0) {
    sections.push(
      `## File outlines — signatures only\n\nThese files were too large to include in full. Ask for one with \`===Need===\` if you must see its body.\n\n${context.skeletons
        .map((entry) => `### ${entry.path}\n\n${fence(entry.skeleton)}`)
        .join("\n\n")}`,
    );
  }

  if (context.omitted.length > 0) {
    sections.push(
      `## Not shown — request with ===Need===\n\n${context.omitted
        .map((entry) => `- ${entry.path} (${entry.lines} lines)`)
        .join("\n")}`,
    );
  }

  if (context.verification.length > 0) {
    sections.push(
      `## Verification output\n\n${fence(verificationBlock(context.verification))}`,
    );
  }

  sections.push(
    `## Your next action\n\nMake the smallest batch of edits that advances the plan. If a file you need is not shown above, request it with \`===Need===\` instead of guessing its contents.`,
  );

  sections.push(OUTPUT_CONTRACT);

  // The nonce travels last, in its own labelled block. It is short, it is not
  // a secret (the user reads the prompt), and its only job is to let the app
  // tell one turn's response from another's.
  sections.push(`## Turn reference\n\n${nonce}`);

  const prompt = sections.join("\n\n");
  return {
    sessionId: session.id,
    turnIndex,
    prompt,
    tokenCount: estimateTokens(prompt),
    includedPaths: context.files.map((file) => file.path),
    omittedPaths: context.omitted.map((entry) => entry.path),
    nonce,
    fileHashes: Object.fromEntries(
      context.files.map((file) => [file.path, contentHash(file.content)]),
    ),
  };
}

/** Narrow a stored turn's verification for display. */
export function lastVerification(turns: Turn[]): VerificationResult[] {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.verification !== undefined) return turn.verification;
  }
  return [];
}
