/**
 * Runs an eval task against the real `SessionEngine` in a temp directory and
 * reports the metrics that make "agentic parity" a number instead of a claim.
 */
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Session } from "../../src/shared/types";
import { SessionEngine, newSession } from "../../src/main/services/session/session-engine";
import type { TurnExecutor, TurnRequest, TurnResponse } from "../../src/main/services/session/executors/types";
import type { EvalTask } from "./types";

export interface EvalMetrics {
  name: string;
  /** Green after this many turns; null when it never converged. */
  turnsToGreen: number | null;
  /** Turns that verification marked as a regression and rolled back. */
  regressions: number;
  /** Turns refused by an output guard. */
  repairs: number;
  filesTouched: string[];
  /** Wall-clock time for the whole run. */
  durationMs: number;
  passed: boolean;
}

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function materialize(root: string, files: { path: string; content: string }[]): Promise<void> {
  for (const file of files) {
    const absolute = path.join(root, file.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, file.content, "utf8");
  }
  git(root, ["init"]);
  git(root, ["config", "user.email", "eval@example.com"]);
  git(root, ["config", "user.name", "Eval"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
}

function readFiles(root: string, paths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const relative of paths) {
    try {
      map.set(relative, readFileSync(path.join(root, relative), "utf8"));
    } catch {
      // Missing files are expected mid-task.
    }
  }
  return map;
}

class ScriptedExecutor implements TurnExecutor {
  readonly kind = "clipboard" as const;
  constructor(
    private readonly task: EvalTask,
    private readonly root: string,
    private readonly filePaths: string[],
  ) {}

  async execute(request: TurnRequest): Promise<TurnResponse> {
    // The engine does not expose the turn number to the executor, so derive it
    // from how many prompts this executor has seen.
    this.turn += 1;
    const files = readFiles(this.root, this.filePaths);
    return { text: this.task.respond(this.turn, request.prompt, files), source: "clipboard" };
  }

  cancel(): void {
    /* scripted turns are instantaneous */
  }

  private turn = 0;
}

export async function runTask(task: EvalTask): Promise<EvalMetrics> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `abpp-eval-${task.name}-`));
  const started = Date.now();
  try {
    await materialize(root, task.files);

    const executor = new ScriptedExecutor(
      task,
      root,
      task.files.map((file) => file.path),
    );
    const engine = new SessionEngine(executor, {
      verificationCommands: [{ command: task.verifyCommand, stage: "test" }],
      maxTurns: task.maxTurns ?? 4,
    });

    const session: Session = newSession({ projectRoot: root, task: task.task });
    await engine.start(session);

    let turns = 0;
    let green = false;

    // Bounded by maxTurns in the engine, but this loop also guards against a
    // bug in the engine turning "no next turn" into an infinite loop.
    while (turns < (task.maxTurns ?? 4) + 2) {
      const current = engine.session;
      if (current === null || engine.prompt === null) break;

      const text = await engine.runPendingTurn();
      const result = await engine.submit(text.text);
      turns += 1;

      if (result.session.status === "green") {
        green = true;
        break;
      }
      if (result.nextTurn === null) break;
    }

    const final = engine.session;
    const filesTouched = [
      ...new Set(
        (final?.turns ?? []).flatMap((turn) =>
          (turn.applied ?? []).filter((result) => result.status !== "failed").map((r) => r.path),
        ),
      ),
    ];

    return {
      name: task.name,
      turnsToGreen: green ? turns : null,
      regressions:
        final?.turns.filter((turn) => turn.outcome === "regressed").length ?? 0,
      repairs: final?.turns.filter((turn) => turn.outcome === "rejected").length ?? 0,
      filesTouched,
      durationMs: Date.now() - started,
      passed: task.expectFailure === true ? !green : green,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function formatMetrics(metrics: EvalMetrics[]): string {
  const rows = metrics.map((entry) => {
    const status = entry.passed ? "PASS" : "FAIL";
    return [
      status.padEnd(5),
      entry.name.padEnd(28),
      `turns=${entry.turnsToGreen ?? "-"}`.padEnd(11),
      `regressions=${entry.regressions}`.padEnd(14),
      `repairs=${entry.repairs}`.padEnd(10),
      `files=${entry.filesTouched.length}`,
    ].join(" ");
  });

  const converged = metrics.filter((entry) => entry.turnsToGreen !== null).length;
  const regressions = metrics.reduce((total, entry) => total + entry.regressions, 0);
  const repairs = metrics.reduce((total, entry) => total + entry.repairs, 0);

  return [
    ...rows,
    "",
    `converged: ${converged}/${metrics.length}`,
    `regressions: ${regressions}`,
    `repairs: ${repairs}`,
  ].join("\n");
}
