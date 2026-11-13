import { describe, expect, it } from "vitest";
import { allTasks } from "./fixtures";
import { runTask } from "./run";

/**
 * These run the real session engine against real temp repositories. The
 * verification commands need `npx tsx`, which is slow on a cold cache, so the
 * suite is opt-in: `ABPP_EVAL=1 npm run eval`.
 *
 * The assertions are the parity bar from the plan:
 *   - a solvable task reaches green in <= 3 turns
 *   - a task that needs the failure log still converges
 *   - a truncated response is repaired rather than written
 *   - a task that cannot be solved is reported as failed, not as green
 */
const enabled = process.env.ABPP_EVAL === "1";

describe.skipIf(!enabled)("eval harness", () => {
  it("retry task converges immediately", async () => {
    const task = allTasks.find((entry) => entry.name === "retry-recovers");
    expect(task).toBeDefined();

    const metrics = await runTask(task!);

    expect(metrics.passed).toBe(true);
    expect(metrics.turnsToGreen).toBe(1);
    expect(metrics.filesTouched).toEqual(["src/retry.ts"]);
  }, 120_000);

  it("converges within three turns when the failure log is needed", async () => {
    const task = allTasks.find((entry) => entry.name === "retry-needs-failure-log");
    expect(task).toBeDefined();

    const metrics = await runTask(task!);

    expect(metrics.passed).toBe(true);
    expect(metrics.turnsToGreen).not.toBeNull();
    expect(metrics.turnsToGreen!).toBeLessThanOrEqual(3);
  }, 120_000);

  it("repairs a truncated response instead of writing it", async () => {
    const task = allTasks.find((entry) => entry.name === "truncation-repaired");
    expect(task).toBeDefined();

    const metrics = await runTask(task!);

    expect(metrics.passed).toBe(true);
    expect(metrics.repairs).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("reports a non-converging task as failed", async () => {
    const task = allTasks.find((entry) => entry.name === "never-converges");
    expect(task).toBeDefined();

    const metrics = await runTask(task!);

    expect(metrics.passed).toBe(true); // expectFailure: the harness asserted failure correctly
    expect(metrics.turnsToGreen).toBeNull();
  }, 120_000);
});
