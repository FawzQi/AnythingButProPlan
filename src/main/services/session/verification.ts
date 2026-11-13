/**
 * Verification for a session turn: run a fixed sequence of commands, parse the
 * failures, and decide whether the turn made things worse.
 *
 * Two rules come from experience with the app's own loop:
 *   - Run stages in a fixed order and stop at the first failure. Typecheck is
 *     fast and catches most of what a test run would report anyway.
 *   - A turn that increases the failure count relative to the baseline is a
 *     regression. It gets rolled back, not "fixed in the next turn".
 */
import type { VerificationFailure, VerificationResult } from "@shared/types";
import { runDebugCommands } from "../coding/debug-runner";

export type VerificationStage = VerificationResult["stage"];

export interface VerificationCommand {
  command: string;
  stage: VerificationStage;
}

export interface VerificationOptions {
  projectRoot: string;
  commands: VerificationCommand[];
  /** Called as each stage starts, for UI progress. */
  onStage?: (stage: VerificationStage, command: string) => void;
  /** Abort early when the session was cancelled. */
  isCancelled?: () => boolean;
}

/**
 * Parse common compiler and test-runner output into structured failures.
 *
 * One tolerant parser for all stages rather than a per-tool plugin system:
 * the shapes below cover tsc, eslint, vitest, jest, pytest, and go test, which
 * is everything this app targets.
 */
export function parseFailures(output: string): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const seen = new Set<string>();

  const push = (failure: VerificationFailure): void => {
    const key = `${failure.file}|${failure.line}|${failure.test}|${failure.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push(failure);
  };

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // TypeScript: src/a.ts(12,5): error TS1234: message
    const tsc = /^(\S+?)\((\d+),\d+\):\s*error\s+(TS\d+:.*)$/.exec(trimmed);
    if (tsc) {
      push({ file: tsc[1] ?? null, line: Number(tsc[2]), test: null, message: (tsc[3] ?? "").trim() });
      continue;
    }

    // ESLint compact / stylish: /abs/path.ts:12:5  error  message  rule
    const eslint = /^(\S+?):(\d+):(\d+)\s+(error|warning)\s+(.*)$/.exec(trimmed);
    if (eslint) {
      push({
        file: eslint[1] ?? null,
        line: Number(eslint[2]),
        test: null,
        message: `${eslint[5]} (${eslint[4]})`.trim(),
      });
      continue;
    }

    // Vitest / Jest: FAIL src/a.test.ts > suite > test
    const testFail = /^(?:FAIL|✕|×)\s+(.+)$/.exec(trimmed);
    if (testFail) {
      const body = (testFail[1] ?? "").trim();
      const [filePart, ...rest] = body.split(" > ");
      push({
        file: filePart ?? null,
        line: null,
        test: rest.length > 0 ? rest.join(" > ") : filePart ?? null,
        message: body,
      });
      continue;
    }

    // Pytest: FAILED tests/test_a.py::test_name - message
    const pytest = /^FAILED\s+(\S+?)(?:::(.+?))?(?:\s+-\s+(.*))?$/.exec(trimmed);
    if (pytest) {
      push({
        file: (pytest[1] ?? "").split("::")[0] ?? null,
        line: null,
        test: pytest[2] ?? null,
        message: (pytest[3] ?? trimmed).trim(),
      });
      continue;
    }

    // AssertionError / Error: message lines are kept as context only when a
    // file was already associated; otherwise they are noise from stack traces.
  }

  return failures;
}

/**
 * Number of distinct failures. Used as the regression metric — a count, not a
 * boolean, because going from 40 failing tests to 3 is progress even though
 * both are "not green".
 */
function failureCount(results: VerificationResult[]): number {
  return results.reduce((total, result) => total + result.failures.length, 0);
}

/**
 * Run each stage in order until one fails. Returns every stage that ran.
 */
export async function runVerification(
  options: VerificationOptions,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const { command, stage } of options.commands) {
    if (options.isCancelled?.() === true) break;
    options.onStage?.(stage, command);

    const started = Date.now();
    const response = await runDebugCommands(options.projectRoot, [command]);
    const result = response.results[0];
    const output = response.aggregatedLog;

    results.push({
      command,
      stage,
      success: response.success,
      exitCode: result?.exitCode ?? 1,
      failures: response.success ? [] : parseFailures(output),
      output: trimOutput(output),
      durationMs: Date.now() - started,
    });

    if (!response.success) break;
  }

  return results;
}

/** Keep the tail: the last lines of a failing run are the useful ones. */
function trimOutput(output: string, maxChars = 12_000): string {
  if (output.length <= maxChars) return output;
  return `[… ${output.length - maxChars} characters omitted …]\n${output.slice(-maxChars)}`;
}

export interface RegressionCheck {
  regressed: boolean;
  baselineCount: number;
  currentCount: number;
  /** Human-readable line for the regression log shown to the user. */
  message: string;
}

/**
 * Compare a turn's verification against the pre-session baseline.
 *
 * A turn regresses when it has more failures than the baseline, or when the
 * baseline was green and the turn is not. Equal-or-better is never a
 * regression, even if the specific failures changed — churn between two
 * different failures is normal while refactoring.
 */
export function checkRegression(
  baseline: VerificationResult[],
  current: VerificationResult[],
): RegressionCheck {
  const baselineCount = failureCount(baseline);
  const currentCount = failureCount(current);

  const baselineGreen = baseline.every((result) => result.success);
  const currentGreen = current.every((result) => result.success);

  const regressed =
    (!currentGreen && baselineGreen) || currentCount > baselineCount;

  return {
    regressed,
    baselineCount,
    currentCount,
    message: regressed
      ? `Verification regressed: ${baselineCount} failure(s) before, ${currentCount} after.`
      : `Verification: ${baselineCount} failure(s) before, ${currentCount} after.`,
  };
}

/** A compact failure summary suitable for `session.decisions` or a log. */
export function summarizeVerification(results: VerificationResult[]): string {
  const failed = results.filter((result) => !result.success);
  if (failed.length === 0) return "All verification stages passed.";
  return failed
    .map((result) => {
      const first = result.failures[0];
      const detail = first
        ? `${[first.file, first.line].filter(Boolean).join(":")} ${first.message}`
        : result.output.split("\n").slice(-1)[0] ?? "";
      return `${result.stage} failed (${result.failures.length}): ${detail}`;
    })
    .join("; ");
}
