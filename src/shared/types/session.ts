/**
 * Types for the coding session: the state machine that turns a copy-paste web
 * chat into an agent loop.
 *
 * The invariant that matters is **every turn is reconstructable from disk**.
 * A session lives in `.abpp/sessions/<id>.json` inside the project, so an app
 * restart, a renderer reload, or a week-long pause loses nothing.
 */
import type { ApplyResult, ParseResult } from "./response";

export type SessionStatus =
  | "active"
  | "awaiting-response"
  | "green"
  | "blocked"
  | "abandoned";

export type PlanStepStatus = "pending" | "active" | "done" | "blocked";

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
}

/**
 * What happened on one turn. The engine branches on this rather than on the
 * raw response text.
 */
export type TurnOutcome =
  | "applied"
  | "needed-context"
  | "no-op"
  | "rejected"
  | "regressed"
  | "failed";

export interface VerificationFailure {
  file: string | null;
  line: number | null;
  test: string | null;
  message: string;
}

export interface VerificationResult {
  /** Which command produced this result. */
  command: string;
  stage: "typecheck" | "lint" | "test" | "custom";
  success: boolean;
  exitCode: number;
  /** Failures parsed out of the output, most specific first. */
  failures: VerificationFailure[];
  /** Tail-trimmed raw output, kept for the next turn's prompt. */
  output: string;
  /** Milliseconds the command took. */
  durationMs: number;
}

export interface Turn {
  index: number;
  /** The exact prompt the app produced. Kept for replay and debugging. */
  prompt: string;
  /** The raw text pasted back (or returned by the API executor). */
  response?: string;
  /** Parsed form of `response`, including the session-specific sections. */
  parsed?: SessionParseResult;
  applied?: ApplyResult[];
  verification?: VerificationResult[];
  outcome?: TurnOutcome;
  /** Failure ledger entry when the turn regressed and was rolled back. */
  regression?: string;
  createdAt: number;
  completedAt?: number;
}

/**
 * A parsed response extended with the session protocol's extra sections.
 * `===Files===` / `===Explanation===` / `===Debug===` come from the existing
 * parser; `needs` and `plan` are new.
 */
export interface SessionParseResult extends ParseResult {
  /** Paths the model asked to see before it can decide. */
  needs: string[];
  /** Replacement plan, when the model changed it. `null` means unchanged. */
  plan: PlanStep[] | null;
}

export interface Session {
  id: string;
  projectRoot: string;
  /** The user's instruction, verbatim. Repeated in every turn prompt. */
  task: string;
  createdAt: number;
  updatedAt: number;
  plan: PlanStep[];
  turns: Turn[];
  /** Durable facts learned across turns ("uses vitest", "no default export here"). */
  decisions: string[];
  /** Verification result before turn 1, used to detect regressions. */
  baseline: VerificationResult[];
  /** Checkpoint created before each applied turn. */
  checkpoints: { turn: number; checkpointId: string }[];
  status: SessionStatus;
  /** Token budget for a single turn prompt. */
  contextBudget: number;
  /** Paths the model has explicitly requested and received. */
  suppliedPaths: string[];
}

/**
 * The minimal cost of a session — everything the list view needs.
 */
export interface SessionSummary {
  id: string;
  task: string;
  status: SessionStatus;
  turnCount: number;
  updatedAt: number;
}

/**
 * What the UI needs to render one pending turn.
 */
export interface TurnPrompt {
  sessionId: string;
  turnIndex: number;
  prompt: string;
  tokenCount: number;
  /** Paths included verbatim in this prompt. */
  includedPaths: string[];
  /** Paths omitted for budget reasons, offered via `===Need===`. */
  omittedPaths: string[];
  /**
   * Turn-scoped token embedded in the prompt so a response pasted from a
   * different turn can be rejected.
   */
  nonce: string;
  /** Content hash of each included file, to detect edits made after emit. */
  fileHashes: Record<string, string>;
}

export interface SessionVerifyCommand {
  command: string;
  stage: "typecheck" | "lint" | "test" | "custom";
}

export interface SessionCreateRequest {
  projectRoot: string;
  task: string;
  /**
   * Commands the engine runs after each applied turn, in order, stopping at
   * the first failure. Empty disables verification: the loop still applies
   * changes, it just makes no claim about them.
   */
  verificationCommands?: SessionVerifyCommand[];
  /** Optional per-session token budget override. */
  contextBudget?: number;
}

export interface SessionSubmitRequest {
  projectRoot: string;
  sessionId: string;
  /** The response text pasted back from the web chat. */
  response: string;
}

export interface SessionSubmitResult {
  session: Session;
  /** Set when the engine produced the next prompt already (auto-advance). */
  nextTurn: TurnPrompt | null;
}

export interface SessionProgressEvent {
  sessionId: string;
  turnIndex: number;
  phase:
    | "building"
    | "awaiting-response"
    | "parsing"
    | "applying"
    | "verifying"
    | "rolling-back"
    | "compacting"
    | "done";
  message: string;
}
