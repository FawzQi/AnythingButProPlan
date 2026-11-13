/**
 * The session state machine.
 *
 * One loop serves both executors:
 *
 *   build prompt → emit → (await response) → parse → branch
 *        → apply → verify → (roll back on regression) → compact → next turn
 *
 * It replaces the older `agent-runner.ts` loop. The differences that matter:
 *
 *   - The model can ask for context it was not given (`===Need===`), so it
 *     stops guessing at file contents.
 *   - Verification is compared against a baseline captured before turn 1, and
 *     a turn that regresses is rolled back rather than compounded.
 *   - Every turn is persisted, so the loop survives a restart.
 *   - The clipboard and API paths share all of it.
 */
import type {
  ApplyResult,
  Session,
  SessionCreateRequest,
  SessionParseResult,
  SessionProgressEvent,
  SessionSubmitResult,
  Turn,
  TurnPrompt,
  VerificationResult,
} from "@shared/types";
import { scanDirectory, readTextFile } from "../core/fs-service";
import { applyFiles } from "../coding/apply-engine";
import { formatSkeleton, skeletonFor } from "../coding/codebase-map";
import {
  createGitCheckpoint,
  rollbackGitCheckpointDetailed,
} from "../git/git-checkpoint";
import { suggestFilesGitNexusJev } from "../git/gitnexus-selector";
import { compactSession, needsCompaction } from "./compaction";
import { collectPaths, fitToBudget, type BudgetCandidate } from "./context-budget";
import type { TurnExecutor, TurnRequest, TurnResponse } from "./executors/types";
import {
  blocksApply,
  inspectFiles,
  matchesTurnNonce,
  repairPrompt,
  type GuardIssue,
} from "./output-guard";
import { parseSessionResponse } from "./response-protocol";
import {
  ensureSessionGitignore,
  newSessionId,
  saveSession,
} from "./session-store";
import { buildTurnPrompt } from "./turn-builder";
import {
  checkRegression,
  runVerification,
  summarizeVerification,
  type VerificationCommand,
} from "./verification";

/** Default prompt budget, in estimated tokens. Conservative on purpose. */
export const DEFAULT_CONTEXT_BUDGET = 60_000;

/** How many turns before the engine stops on its own. */
export const DEFAULT_MAX_TURNS = 12;

export interface SessionEngineOptions {
  onProgress?: (event: SessionProgressEvent) => void;
  /** Commands used for verification. Empty disables verification. */
  verificationCommands?: VerificationCommand[];
  maxTurns?: number;
}

export function newSession(request: SessionCreateRequest): Session {
  const now = Date.now();
  return {
    id: newSessionId(),
    projectRoot: request.projectRoot,
    task: request.task.trim(),
    createdAt: now,
    updatedAt: now,
    plan: [],
    turns: [],
    decisions: [],
    baseline: [],
    checkpoints: [],
    status: "active",
    contextBudget: request.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    suppliedPaths: [],
  };
}

/**
 * The engine holds no cross-session state. Its only job is to drive one
 * session at a time through the loop, using whatever executor it is handed.
 */
export class SessionEngine {
  private current: Session | null = null;
  private pendingPrompt: TurnPrompt | null = null;
  private cancelled = false;

  constructor(
    private readonly executor: TurnExecutor,
    readonly options: SessionEngineOptions = {},
  ) {}

  get session(): Session | null {
    return this.current;
  }

  get prompt(): TurnPrompt | null {
    return this.pendingPrompt;
  }

  cancel(): void {
    this.cancelled = true;
    this.executor.cancel();
  }

  private emit(
    session: Session,
    phase: SessionProgressEvent["phase"],
    message: string,
  ): void {
    this.options.onProgress?.({
      sessionId: session.id,
      turnIndex: session.turns.length + 1,
      phase,
      message,
    });
  }

  /**
   * Capture the pre-session verification result. This is the regression
   * baseline: a turn is judged against the state of the repository before the
   * session started, not against the previous turn, so a slow slide into more
   * failures is still caught.
   */
  async captureBaseline(projectRoot: string): Promise<VerificationResult[]> {
    const commands = this.options.verificationCommands ?? [];
    if (commands.length === 0) return [];
    return runVerification({ projectRoot, commands });
  }

  /** Start a session and produce its first prompt. */
  async start(session: Session): Promise<TurnPrompt> {
    this.current = session;
    this.cancelled = false;
    await ensureSessionGitignore(session.projectRoot);

    if (session.baseline.length === 0 && session.turns.length === 0) {
      session.baseline = await this.captureBaseline(session.projectRoot);
    }

    const prompt = await this.buildPrompt(session);
    this.pendingPrompt = prompt;
    session.status = "awaiting-response";
    session.updatedAt = Date.now();
    await saveSession(session);
    return prompt;
  }

  /**
   * Emit the pending prompt through the executor and wait for the response.
   * Separate from `submit` so the clipboard path can emit, persist, and return
   * control to the UI, with the response arriving later.
   */
  async runPendingTurn(): Promise<TurnResponse> {
    const session = this.requireSession();
    const prompt = this.pendingPrompt;
    if (prompt === null) throw new Error("No pending turn to run.");

    const request: TurnRequest = { prompt: prompt.prompt, nonce: prompt.nonce };
    this.emit(session, "awaiting-response", `Turn ${prompt.turnIndex}: waiting for a response.`);
    return this.executor.execute(request);
  }

  /**
   * Process a response for the pending turn: parse, guard, apply, verify,
   * roll back on regression, compact, and build the next prompt.
   */
  async submit(responseText: string): Promise<SessionSubmitResult> {
    const session = this.requireSession();
    const prompt = this.pendingPrompt;
    if (prompt === null) throw new Error("There is no turn waiting for a response.");

    this.emit(session, "parsing", `Turn ${prompt.turnIndex}: parsing the response.`);

    const parsed = parseSessionResponse(responseText);
    const turn: Turn = {
      index: prompt.turnIndex,
      prompt: prompt.prompt,
      response: responseText,
      parsed,
      createdAt: Date.now(),
    };

    // Wrong-turn guard. The nonce is only present when the prompt was built by
    // this engine; a legacy resumed session may not have one, and skipping the
    // check is correct there rather than rejecting every response.
    if (prompt.nonce !== "" && !matchesTurnNonce(responseText, prompt.nonce)) {
      parsed.warnings.push(
        "This response does not carry the turn reference from the prompt. If it was pasted from an older turn, it may not match these files.",
      );
    }

    // ---- Branch 1: the model asked for context ---------------------------
    if (parsed.needs.length > 0) {
      turn.outcome = "needed-context";
      turn.completedAt = Date.now();
      session.turns.push(turn);
      for (const needed of parsed.needs) {
        if (!session.suppliedPaths.includes(needed)) session.suppliedPaths.push(needed);
      }
      session.status = "awaiting-response";
      const next = await this.buildPrompt(session);
      this.pendingPrompt = next;
      this.current = await this.persist(session);
      return { session: this.current, nextTurn: next };
    }

    // ---- Branch 2: no files to apply -------------------------------------
    const actionable = parsed.files;
    if (actionable.length === 0) {
      turn.outcome = "no-op";
      turn.completedAt = Date.now();
      session.turns.push(turn);
      if (parsed.plan !== null) session.plan = parsed.plan;
      session.status = "blocked";
      this.pendingPrompt = null;
      this.current = await this.persist(session);
      return { session: this.current, nextTurn: null };
    }

    // ---- Branch 3: apply, with guards ------------------------------------
    this.emit(session, "applying", `Turn ${prompt.turnIndex}: applying ${actionable.length} file(s).`);

    const diskContent = await this.readDiskContent(session.projectRoot, actionable);
    const issues = inspectFiles({ files: actionable, diskContent, prompt });
    if (blocksApply(issues)) {
      turn.outcome = "rejected";
      turn.applied = [];
      turn.completedAt = Date.now();
      session.turns.push(turn);
      parsed.warnings.push(repairPrompt(issues));
      session.status = "awaiting-response";
      const next = await this.buildPrompt(session, { issues });
      this.pendingPrompt = next;
      this.current = await this.persist(session);
      return { session: this.current, nextTurn: next };
    }

    const checkpointId =
      this.options.verificationCommands !== undefined &&
      this.options.verificationCommands.length > 0
        ? await createGitCheckpoint(session.projectRoot)
        : null;

    const applied = await this.applyParsed(session.projectRoot, actionable);
    turn.applied = applied;

    // ---- Branch 4: verify -------------------------------------------------
    const commands = this.options.verificationCommands ?? [];
    let verification: VerificationResult[] = [];
    if (commands.length > 0) {
      this.emit(session, "verifying", `Turn ${prompt.turnIndex}: running verification.`);
      verification = await runVerification({
        projectRoot: session.projectRoot,
        commands,
        isCancelled: () => this.cancelled,
      });
      turn.verification = verification;

      const regression = checkRegression(session.baseline, verification);
      if (regression.regressed) {
        this.emit(session, "rolling-back", `Turn ${prompt.turnIndex}: ${regression.message}`);
        const rollback = checkpointId
          ? await rollbackGitCheckpointDetailed(session.projectRoot, checkpointId)
          : null;
        turn.outcome = "regressed";
        turn.regression = [
          regression.message,
          summarizeVerification(verification),
          rollback === null
            ? "No checkpoint was available, so the tree was left as-is."
            : rollback.ok
              ? `Rolled back ${rollback.deleted.length} created file(s) and restored tracked files.`
              : `Rollback reported: ${rollback.errors.join("; ")}`,
        ].join(" ");
        session.decisions.push(`Avoid: ${turn.regression}`);
      } else {
        turn.outcome = verification.every((result) => result.success) ? "applied" : "failed";
      }
    } else {
      turn.outcome = "applied";
    }

    if (checkpointId !== null && turn.outcome !== "regressed") {
      session.checkpoints.push({ turn: prompt.turnIndex, checkpointId });
    }

    turn.completedAt = Date.now();
    session.turns.push(turn);
    if (parsed.plan !== null) session.plan = parsed.plan;

    // ---- Branch 5: done, or another turn ---------------------------------
    const green =
      turn.outcome === "applied" &&
      (verification.length === 0 || verification.every((result) => result.success));

    if (green || session.turns.length >= (this.options.maxTurns ?? DEFAULT_MAX_TURNS)) {
      session.status = green ? "green" : "blocked";
      this.pendingPrompt = null;
      this.current = await this.persist(session);
      return { session: this.current, nextTurn: null };
    }

    session.status = "awaiting-response";
    const next = await this.buildPrompt(session);
    this.pendingPrompt = next;
    this.current = await this.persist(session);
    return { session: this.current, nextTurn: next };
  }

  /** Apply the parsed entries, translating parser shapes into apply requests. */
  private async applyParsed(
    projectRoot: string,
    files: SessionParseResult["files"],
  ): Promise<ApplyResult[]> {
    const inputs = files
      .filter((file) => file.path !== null)
      .map((file) => {
        if (file.kind === "delete") {
          return { path: file.path as string, content: "", delete: true };
        }
        if (file.kind === "patch") {
          return { path: file.path as string, content: file.content, patches: file.patches };
        }
        return { path: file.path as string, content: file.content };
      });

    const results = await applyFiles({ projectRoot, files: inputs, atomic: true });
    // Only report what landed. A failed write is not a modified file.
    return results;
  }

  private async readDiskContent(
    projectRoot: string,
    files: SessionParseResult["files"],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const file of files) {
      if (file.path === null || map.has(file.path)) continue;
      try {
        map.set(file.path, await readTextFile(projectRoot, file.path));
      } catch {
        // A missing file is expected for new files; it simply has no disk
        // content to compare against.
      }
    }
    return map;
  }

  /** Compose the next prompt from plan, disk state, and the turn history. */
  private async buildPrompt(
    session: Session,
    extra?: { issues: GuardIssue[] },
  ): Promise<TurnPrompt> {
    this.emit(session, "building", `Turn ${session.turns.length + 1}: building the prompt.`);

    const scan = await scanDirectory(session.projectRoot);
    const allPaths = collectPaths(scan.tree);

    // Priority 0: files the model asked for. These are always included whole
    // if they exist and fit; that is the entire point of the request.
    const requested = new Set(session.suppliedPaths);

    // Priority 1: files touched by the previous turn.
    const lastTurn = session.turns[session.turns.length - 1];
    const lastApplied = new Set((lastTurn?.applied ?? []).map((result) => result.path));

    // Priority 2+: recall hits seeded by the task and the current failure.
    const recallPaths = await this.recallPaths(session, allPaths);

    const recallRank = new Map<string, number>();
    recallPaths.forEach((path, index) => recallRank.set(path, index));

    const candidates: BudgetCandidate[] = [];
    for (const path of allPaths) {
      const priority = requested.has(path)
        ? 0
        : lastApplied.has(path)
          ? 1
          : recallRank.has(path)
            ? 2 + (recallRank.get(path) ?? 0) / Math.max(1, recallPaths.length)
            : 10;
      // Only load files that have a reason to be in context. Sending the whole
      // repository is what the old fallback did, and it drowned the task.
      if (priority >= 10) continue;

      let content: string;
      try {
        content = await readTextFile(session.projectRoot, path);
      } catch {
        continue;
      }
      const skeleton = priority > 0 ? await this.skeleton(session.projectRoot, path) : undefined;
      candidates.push({ path, content, priority, skeleton });
    }

    // A requested file that does not exist yet is still worth mentioning to the
    // model: it may have been deleted, or the path may be a typo.
    for (const path of requested) {
      if (candidates.some((candidate) => candidate.path === path)) continue;
      candidates.push({
        path,
        content: "",
        priority: 0,
        skeleton: undefined,
      });
    }

    const budgeted = fitToBudget(candidates, session.contextBudget);

    const prompt = buildTurnPrompt(
      session,
      session.turns.length + 1,
      {
        files: budgeted.included.filter((file) => file.content !== "" || requested.has(file.path)),
        skeletons: budgeted.skeletons,
        omitted: budgeted.omitted.map((entry) => ({ path: entry.path, lines: entry.lines })),
        verification: lastTurn?.verification ?? [],
        applied: (lastTurn?.applied ?? [])
          .filter((result) => result.status !== "failed")
          .map((result) => result.path),
      },
      newNonce(),
    );

    if (extra?.issues !== undefined && extra.issues.length > 0) {
      // The repair text is appended as an extra instruction rather than
      // replacing the prompt: the model still needs the files and the plan.
      return {
        ...prompt,
        prompt: `${prompt.prompt}\n\n## Repair required\n\n${repairPrompt(extra.issues)}`,
      };
    }

    return prompt;
  }

  private async skeleton(
    projectRoot: string,
    path: string,
  ): Promise<string | undefined> {
    try {
      const result = await skeletonFor(projectRoot, path);
      return result === null ? undefined : formatSkeleton(result);
    } catch {
      return undefined;
    }
  }

  private async recallPaths(session: Session, allPaths: string[]): Promise<string[]> {
    try {
      const result = await suggestFilesGitNexusJev({
        projectRoot: session.projectRoot,
        filePaths: allPaths,
        instruction: session.task,
      });
      return [...(result.jevIncluded ?? []), ...(result.jevFlagged ?? [])];
    } catch {
      // Recall is an optimisation. Without it the prompt still works: the
      // plan and the model's own `===Need===` requests carry the loop.
      return [];
    }
  }

  /** Compact if needed, then save. */
  private async persist(session: Session): Promise<Session> {
    let next = session;
    if (needsCompaction(session)) {
      this.emit(session, "compacting", "Folding older turns into durable state.");
      next = compactSession(session).session;
    }
    next.updatedAt = Date.now();
    await saveSession(next);
    this.current = next;
    return next;
  }

  private requireSession(): Session {
    if (this.current === null) throw new Error("No session has been started.");
    return this.current;
  }
}

/** Local nonce helper, kept out of the executor module to avoid a cycle. */
function newNonce(): string {
  // `Math.random` is fine here: the nonce distinguishes turns for one user, it
  // is not a security token.
  return `turn-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
