import { describe, expect, it } from "vitest";
import type { VerificationResult } from "../../../src/shared/types";
import {
  checkRegression,
  parseFailures,
  summarizeVerification,
} from "../../../src/main/services/session/verification";

function result(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    command: "npm test",
    stage: "test",
    success: true,
    exitCode: 0,
    failures: [],
    output: "",
    durationMs: 1,
    ...overrides,
  };
}

describe("parseFailures", () => {
  it("parses TypeScript errors", () => {
    const failures = parseFailures("src/a.ts(12,5): error TS2322: Type 'string' is not assignable.");
    expect(failures[0]).toMatchObject({ file: "src/a.ts", line: 12 });
    expect(failures[0]?.message).toContain("TS2322");
  });

  it("parses ESLint stylish output", () => {
    const failures = parseFailures("/repo/src/a.ts:3:9  error  Unexpected any  @typescript-eslint/no-explicit-any");
    expect(failures[0]).toMatchObject({ file: "/repo/src/a.ts", line: 3 });
    expect(failures[0]?.message).toContain("no-explicit-any");
  });

  it("parses Vitest failure lines", () => {
    const failures = parseFailures("FAIL src/a.test.ts > suite > rejects bad input");
    expect(failures[0]?.file).toBe("src/a.test.ts");
    expect(failures[0]?.test).toBe("suite > rejects bad input");
  });

  it("parses pytest failures", () => {
    const failures = parseFailures("FAILED tests/test_a.py::test_retry - AssertionError: 3 != 2");
    expect(failures[0]?.file).toBe("tests/test_a.py");
    expect(failures[0]?.test).toBe("test_retry");
    expect(failures[0]?.message).toContain("3 != 2");
  });

  it("deduplicates identical lines", () => {
    const line = "src/a.ts(1,1): error TS1000: duplicate";
    expect(parseFailures(`${line}\n${line}`)).toHaveLength(1);
  });

  it("returns nothing for clean output", () => {
    expect(parseFailures("Tests  42 passed (42)")).toEqual([]);
  });
});

describe("checkRegression", () => {
  it("flags a green baseline that is no longer green", () => {
    const baseline = [result({ success: true })];
    const current = [result({ success: false, failures: [
      { file: "a.ts", line: 1, test: null, message: "boom" },
    ] })];

    expect(checkRegression(baseline, current).regressed).toBe(true);
  });

  it("flags more failures than the baseline", () => {
    const failure = { file: "a.ts", line: 1, test: null, message: "boom" };
    const baseline = [result({ success: false, failures: [failure] })];
    const current = [result({ success: false, failures: [failure, { ...failure, message: "two" }] })];

    expect(checkRegression(baseline, current).regressed).toBe(true);
  });

  it("does not flag fewer failures than the baseline", () => {
    const failure = { file: "a.ts", line: 1, test: null, message: "boom" };
    const baseline = [result({ success: false, failures: [failure, { ...failure, message: "two" }] })];
    const current = [result({ success: false, failures: [failure] })];

    expect(checkRegression(baseline, current).regressed).toBe(false);
  });

  it("does not flag a different failure with the same count", () => {
    // Churn while refactoring is normal; only a higher count or losing green
    // counts as a regression.
    const baseline = [result({ success: false, failures: [
      { file: "a.ts", line: 1, test: null, message: "one" },
    ] })];
    const current = [result({ success: false, failures: [
      { file: "b.ts", line: 2, test: null, message: "two" },
    ] })];

    expect(checkRegression(baseline, current).regressed).toBe(false);
  });

  it("does not flag when both are green", () => {
    expect(checkRegression([result()], [result()]).regressed).toBe(false);
  });
});

describe("summarizeVerification", () => {
  it("returns a success line when everything passed", () => {
    expect(summarizeVerification([result()])).toBe("All verification stages passed.");
  });

  it("names the failing stage and its first failure", () => {
    const summary = summarizeVerification([
      result({
        success: false,
        stage: "typecheck",
        failures: [{ file: "src/a.ts", line: 4, test: null, message: "TS1000: nope" }],
      }),
    ]);

    expect(summary).toContain("typecheck failed");
    expect(summary).toContain("src/a.ts:4");
  });
});
