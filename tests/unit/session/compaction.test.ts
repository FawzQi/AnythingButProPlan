import { describe, expect, it } from "vitest";
import type { Session, Turn } from "../../../src/shared/types";
import {
  KEEP_RECENT_TURNS,
  compactSession,
  needsCompaction,
} from "../../../src/main/services/session/compaction";

function makeTurn(index: number, overrides: Partial<Turn> = {}): Turn {
  return {
    index,
    prompt: `prompt ${index} `.repeat(200),
    response: `response ${index} `.repeat(200),
    outcome: "applied",
    createdAt: index,
    ...overrides,
  };
}

function makeSession(turns: Turn[]): Session {
  return {
    id: "s-1",
    projectRoot: "/tmp/x",
    task: "build the thing",
    createdAt: 0,
    updatedAt: 0,
    plan: [{ id: "step-1", text: "build the thing", status: "active" }],
    turns,
    decisions: [],
    baseline: [],
    checkpoints: [],
    status: "active",
    contextBudget: 60_000,
    suppliedPaths: [],
  };
}

describe("compaction", () => {
  it("does nothing below the threshold", () => {
    const session = makeSession([makeTurn(1), makeTurn(2)]);
    const result = compactSession(session);

    expect(result.compacted).toBe(false);
    expect(result.session.turns).toHaveLength(2);
  });

  it("keeps the most recent turns verbatim", () => {
    const turns = Array.from({ length: 10 }, (_, index) => makeTurn(index + 1));
    const result = compactSession(makeSession(turns));

    expect(result.compacted).toBe(true);
    expect(result.session.turns).toHaveLength(KEEP_RECENT_TURNS);
    expect(result.session.turns[0]?.prompt).toContain("prompt 5");
  });

  it("always keeps the task and the plan", () => {
    const turns = Array.from({ length: 10 }, (_, index) => makeTurn(index + 1));
    const result = compactSession(makeSession(turns));

    expect(result.session.task).toBe("build the thing");
    expect(result.session.plan).toHaveLength(1);
  });

  it("folds failures into the decision ledger", () => {
    const turns = [
      makeTurn(1, { outcome: "regressed", regression: "tests went from 0 to 2 failures" }),
      ...Array.from({ length: 7 }, (_, index) => makeTurn(index + 2)),
    ];

    const result = compactSession(makeSession(turns));

    expect(result.session.decisions.some((entry) => entry.includes("tests went from 0 to 2"))).toBe(
      true,
    );
  });

  it("is deterministic for the same input", () => {
    const turns = Array.from({ length: 9 }, (_, index) => makeTurn(index + 1));
    const first = compactSession(makeSession(turns));
    const second = compactSession(makeSession(turns));

    expect(JSON.stringify(first.session)).toBe(JSON.stringify(second.session));
  });

  it("renumbers the surviving turns from 1", () => {
    const turns = Array.from({ length: 10 }, (_, index) => makeTurn(index + 1));
    const result = compactSession(makeSession(turns));

    expect(result.session.turns.map((turn) => turn.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports whether compaction is needed", () => {
    expect(needsCompaction(makeSession([makeTurn(1)]))).toBe(false);
    expect(
      needsCompaction(
        makeSession(Array.from({ length: KEEP_RECENT_TURNS + 1 }, (_, index) => makeTurn(index + 1))),
      ),
    ).toBe(true);
  });
});
