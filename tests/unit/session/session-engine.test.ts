import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../../src/shared/types";
import { SessionEngine, newSession } from "../../../src/main/services/session/session-engine";
import { loadSession } from "../../../src/main/services/session/session-store";
import type { TurnExecutor, TurnRequest, TurnResponse } from "../../../src/main/services/session/executors/types";

/**
 * Scripted executor: returns queued responses and records the prompts, so the
 * whole loop can be exercised without a web chat or a network.
 */
class ScriptedExecutor implements TurnExecutor {
  readonly kind = "clipboard" as const;
  readonly prompts: string[] = [];
  private queue: string[] = [];

  enqueue(response: string): void {
    this.queue.push(response);
  }

  async execute(request: TurnRequest): Promise<TurnResponse> {
    this.prompts.push(request.prompt);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("ScriptedExecutor ran out of responses.");
    return { text: next, source: "clipboard" };
  }

  cancel(): void {
    /* nothing in flight */
  }
}

let root: string;
let executor: ScriptedExecutor;
let engine: SessionEngine;

function filesResponse(files: { path: string; content: string }[], extra: string[] = []): string {
  const body = files
    .map((file) => `File: ${file.path}\n\`\`\`ts\n${file.content}\n\`\`\``)
    .join("\n\n");
  return [
    ...extra,
    "===Files===",
    body,
    "======",
    "===Explanation===",
    "Applied.",
    "======",
    "===Debug===",
    "None",
    "======",
  ].join("\n");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-session-engine-"));
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1\n", "utf8");
  executor = new ScriptedExecutor();
  engine = new SessionEngine(executor);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function session(overrides: Partial<Session> = {}): Session {
  return { ...newSession({ projectRoot: root, task: "change a" }), ...overrides };
}

describe("SessionEngine", () => {
  it("builds a prompt that carries the task, the plan rules and a nonce", async () => {
    const prompt = await engine.start(session());

    expect(prompt.prompt).toContain("change a");
    expect(prompt.prompt).toContain("===Need===");
    expect(prompt.prompt).toContain("===Plan===");
    expect(prompt.prompt).toContain(prompt.nonce);
    expect(prompt.tokenCount).toBeGreaterThan(0);
  });

  it("persists the session at start", async () => {
    const started = session();
    await engine.start(started);

    const stored = await loadSession(root, started.id);
    expect(stored?.task).toBe("change a");
    expect(stored?.status).toBe("awaiting-response");
  });

  it("applies a response and records it as a turn", async () => {
    const started = session();
    await engine.start(started);
    executor.enqueue(filesResponse([{ path: "a.ts", content: "export const a = 2" }]));

    // Go through the executor, which is how the clipboard path gets the text.
    const response = await engine.runPendingTurn();
    const result = await engine.submit(response.text);

    expect(result.session.turns).toHaveLength(1);
    expect(result.session.turns[0]?.outcome).toBe("applied");
    await expect(fs.readFile(path.join(root, "a.ts"), "utf8")).resolves.toContain("a = 2");
  });

  it("branches on ===Need=== without applying anything", async () => {
    await engine.start(session());
    const needResponse = ["===Need===", "a.ts", "======"].join("\n");

    const result = await engine.submit(needResponse);

    expect(result.session.turns[0]?.outcome).toBe("needed-context");
    expect(result.session.suppliedPaths).toContain("a.ts");
    // The next prompt must contain the requested file's content.
    expect(result.nextTurn?.prompt).toContain("export const a = 1");
  });

  it("treats a response with no files as a no-op and stops", async () => {
    await engine.start(session());
    const result = await engine.submit("===Files===\n======\n===Explanation===\nNone\n======\n===Debug===\nNone\n======");

    expect(result.session.turns[0]?.outcome).toBe("no-op");
    expect(result.session.status).toBe("blocked");
    expect(result.nextTurn).toBeNull();
  });

  it("rejects a truncated response and asks for a repair instead of writing", async () => {
    await fs.writeFile(
      path.join(root, "a.ts"),
      Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n",
      "utf8",
    );
    await engine.start(session());

    // Unterminated fence plus a huge shrink: both guards should fire.
    const truncated = [
      "===Files===",
      "File: a.ts",
      "```ts",
      "export const v0 = 0;",
    ].join("\n");

    const result = await engine.submit(truncated);

    expect(result.session.turns[0]?.outcome).toBe("rejected");
    expect(result.session.turns[0]?.applied).toEqual([]);
    const onDisk = await fs.readFile(path.join(root, "a.ts"), "utf8");
    expect(onDisk.split("\n")).toHaveLength(101);
    expect(result.nextTurn?.prompt).toContain("Repair required");
  });

  it("updates the plan when the response includes one", async () => {
    const started = session();
    await engine.start(started);
    const response = [
      "===Plan===",
      "- [x] step one",
      "- [ ] step two",
      "======",
      filesResponse([{ path: "a.ts", content: "export const a = 3" }]),
    ].join("\n");

    const result = await engine.submit(response);

    expect(result.session.plan.map((step) => step.status)).toEqual(["done", "pending"]);
  });

  it("keeps a requested file in context on the following turn", async () => {
    await engine.start(session());
    const need = ["===Need===", "a.ts", "======"].join("\n");
    const first = await engine.submit(need);

    expect(first.nextTurn?.includedPaths).toContain("a.ts");
  });
});
