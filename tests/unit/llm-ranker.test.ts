import { describe, expect, it } from "vitest";
import { parseVerdicts } from "../../src/main/services/llm-ranker";

const known = new Set(["src/a.ts", "src/b.ts"]);

describe("parseVerdicts", () => {
  it("parses the plain JSON object the prompt asks for", () => {
    const verdicts = parseVerdicts(
      '{"files":[{"path":"src/a.ts","score":3,"confidence":0.9,"reason":"touched"}]}',
      known,
    );
    expect(verdicts).toEqual([
      { path: "src/a.ts", score: 3, confidence: 0.9, reason: "touched" },
    ]);
  });

  it("salvages a verdict buried under a fenced block and prose", () => {
    const verdicts = parseVerdicts(
      'Here you go:\n```json\n{"files":[{"path":"src/b.ts","score":2,"confidence":0.5}]}\n```\nHope that helps!',
      known,
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.score).toBe(2);
  });

  it("tolerates the trailing comma real models emit", () => {
    const verdicts = parseVerdicts(
      '{"files":[{"path":"src/a.ts","score":1,"confidence":0.2},]}',
      known,
    );
    expect(verdicts[0]?.score).toBe(1);
  });

  it("drops paths the model invented and clamps out-of-range scores", () => {
    const verdicts = parseVerdicts(
      '{"files":[{"path":"src/ghost.ts","score":3,"confidence":1},{"path":"src/a.ts","score":9,"confidence":2,"reason":"  "}]}',
      known,
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toEqual({ path: "src/a.ts", score: 3, confidence: 1 });
  });

  it("returns nothing when there is no object to salvage", () => {
    expect(parseVerdicts("I cannot rate these files.", known)).toEqual([]);
  });
});
