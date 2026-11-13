import { describe, expect, it } from "vitest";
import type { FileNode } from "../../../src/shared/types";
import {
  collectPaths,
  estimateTokens,
  fitToBudget,
  type BudgetCandidate,
} from "../../../src/main/services/session/context-budget";

describe("estimateTokens", () => {
  it("is pessimistic rather than optimistic", () => {
    // 320 chars at 3.2 chars/token is exactly 100.
    expect(estimateTokens("a".repeat(320))).toBe(100);
  });
});

describe("fitToBudget", () => {
  const small = (path: string, priority: number): BudgetCandidate => ({
    path,
    content: "x".repeat(320),
    priority,
  });

  it("includes files in priority order", () => {
    const result = fitToBudget([small("c.ts", 3), small("a.ts", 1), small("b.ts", 2)], 10_000);

    expect(result.included.map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("breaks ties on path so the output is deterministic", () => {
    const first = fitToBudget([small("b.ts", 1), small("a.ts", 1)], 10_000);
    const second = fitToBudget([small("a.ts", 1), small("b.ts", 1)], 10_000);

    expect(first.included.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(second.included.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("omits files that do not fit and reports them", () => {
    // Budget for roughly two 100-token files.
    const result = fitToBudget(
      [small("a.ts", 1), small("b.ts", 2), small("c.ts", 3), small("d.ts", 4)],
      250,
    );

    expect(result.included.length).toBeLessThan(4);
    expect(result.omitted.length).toBeGreaterThan(0);
    expect(result.omitted.every((entry) => entry.reason === "budget")).toBe(true);
  });

  it("never exceeds the budget", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => small(`f${index}.ts`, index));
    const result = fitToBudget(candidates, 1_000);

    expect(result.tokensUsed).toBeLessThanOrEqual(result.budget);
  });

  it("uses the skeleton when a file is too large", () => {
    const big: BudgetCandidate = {
      path: "big.ts",
      content: "x".repeat(10_000),
      skeleton: "export function big(): void",
      priority: 1,
    };

    const result = fitToBudget([big], 2_000);

    expect(result.included).toHaveLength(0);
    expect(result.skeletons.map((entry) => entry.path)).toEqual(["big.ts"]);
  });

  it("drops a file with no skeleton rather than overflowing", () => {
    const big: BudgetCandidate = { path: "big.ts", content: "x".repeat(10_000), priority: 1 };
    const result = fitToBudget([big], 1_000);

    expect(result.included).toHaveLength(0);
    expect(result.omitted.map((entry) => entry.path)).toEqual(["big.ts"]);
  });
});

describe("collectPaths", () => {
  it("walks the tree and sorts", () => {
    const tree: FileNode = {
      id: "root",
      name: "root",
      path: "",
      type: "directory",
      selected: false,
      expanded: true,
      children: [
        { id: "b", name: "b.ts", path: "b.ts", type: "file", selected: false, expanded: false },
        {
          id: "src",
          name: "src",
          path: "src",
          type: "directory",
          selected: false,
          expanded: true,
          children: [
            { id: "a", name: "a.ts", path: "src/a.ts", type: "file", selected: false, expanded: false },
          ],
        },
      ],
    };

    expect(collectPaths(tree)).toEqual(["b.ts", "src/a.ts"]);
  });

  it("handles a null tree", () => {
    expect(collectPaths(null)).toEqual([]);
  });
});
