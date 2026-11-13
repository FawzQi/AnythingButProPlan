import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionEngine, newSession } from "../../../src/main/services/session/session-engine";
import { loadSession } from "../../../src/main/services/session/session-store";
import type { TurnExecutor, TurnRequest, TurnResponse } from "../../../src/main/services/session/executors/types";

class QueueExecutor implements TurnExecutor {
  readonly kind = "clipboard" as const;
  private queue: string[] = [];

  enqueue(response: string): void {
    this.queue.push(response);
  }

  async execute(_request: TurnRequest): Promise<TurnResponse> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error("no response queued");
    return { text: next, source: "clipboard" };
  }

  cancel(): void {
    /* no-op */
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function response(path: string, content: string): string {
  return [
    "===Files===",
    `File: ${path}`,
    "```ts",
    content,
    "```",
    "======",
    "===Explanation===",
    "Changed.",
    "======",
    "===Debug===",
    "None",
    "======",
  ].join("\n");
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-session-regression-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "T"]);
  await fs.writeFile(path.join(root, "value.ts"), "export const value = 1\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("SessionEngine regression handling", () => {
  it("keeps a good change when verification stays green", async () => {
    const command = `node -e "const s=require('fs').readFileSync('value.ts','utf8'); process.exit(s.includes('value = 2')?0:1)"`;
    const executor = new QueueExecutor();
    const engine = new SessionEngine(executor, {
      verificationCommands: [{ stage: "test", command }],
    });

    // Baseline starts red (the file still says value = 1).
    const started = newSession({ projectRoot: root, task: "set value to 2" });
    await engine.start(started);
    const stored = await loadSession(root, started.id);
    expect(stored?.baseline[0]?.success).toBe(false);

    executor.enqueue(response("value.ts", "export const value = 2"));
    const text = await engine.runPendingTurn();
    const result = await engine.submit(text.text);

    expect(result.session.turns[0]?.outcome).toBe("applied");
    expect(result.session.status).toBe("green");
    await expect(fs.readFile(path.join(root, "value.ts"), "utf8")).resolves.toContain("value = 2");
  });

  it("restores the file when a turn introduces a new failure", async () => {
    // Baseline: command passes only when value.ts contains `value = 1`.
    const command = `node -e "const s=require('fs').readFileSync('value.ts','utf8'); process.exit(s.includes('value = 1')?0:1)"`;
    const executor = new QueueExecutor();
    const engine = new SessionEngine(executor, {
      verificationCommands: [{ stage: "test", command }],
    });

    const started = newSession({ projectRoot: root, task: "break the value" });
    await engine.start(started);

    const stored = await loadSession(root, started.id);
    expect(stored?.baseline[0]?.success).toBe(true);

    executor.enqueue(response("value.ts", "export const value = 99"));
    const text = await engine.runPendingTurn();
    const result = await engine.submit(text.text);

    expect(result.session.turns[0]?.outcome).toBe("regressed");
    expect(result.session.turns[0]?.regression).toContain("regressed");
    // The file is back to its committed content.
    await expect(fs.readFile(path.join(root, "value.ts"), "utf8")).resolves.toBe(
      "export const value = 1\n",
    );
  });

  it("records a checkpoint for an applied turn", async () => {
    const command = `node -e "process.exit(0)"`;
    const executor = new QueueExecutor();
    const engine = new SessionEngine(executor, {
      verificationCommands: [{ stage: "test", command }],
    });

    const started = newSession({ projectRoot: root, task: "noop edit" });
    await engine.start(started);

    executor.enqueue(response("value.ts", "export const value = 5"));
    const text = await engine.runPendingTurn();
    const result = await engine.submit(text.text);

    expect(result.session.turns[0]?.outcome).toBe("applied");
    expect(result.session.checkpoints).toHaveLength(1);
  });
});
