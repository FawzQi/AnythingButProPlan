import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runDebugCommands,
  stripAnsi,
} from "../../../src/main/services/coding/debug-runner";
import type { DebugProgressEvent } from "@shared/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "debug-runner-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("stripAnsi", () => {
  it("removes ANSI color codes and style sequences", () => {
    const raw = "\x1B[31mError:\x1B[0m \x1B[1mfailed\x1B[22m";
    expect(stripAnsi(raw)).toBe("Error: failed");
  });

  it("leaves normal strings unchanged", () => {
    expect(stripAnsi("Hello world!")).toBe("Hello world!");
  });
});

describe("runDebugCommands", () => {
  it("handles empty commands array", async () => {
    const res = await runDebugCommands(tmpDir, []);
    expect(res.results).toEqual([]);
    expect(res.aggregatedLog).toBe("");
    expect(res.success).toBe(true);
  });

  it("runs commands sequentially one by one and aggregates logs", async () => {
    const progressEvents: DebugProgressEvent[] = [];
    const commands = [
      'node -e "console.log(\'step 1\')"',
      'node -e "console.log(\'step 2\')"',
    ];

    const res = await runDebugCommands(tmpDir, commands, (event) => {
      progressEvents.push(event);
    });

    expect(res.results).toHaveLength(2);
    expect(res.results[0].command).toBe(commands[0]);
    expect(res.results[0].stdout.trim()).toBe("step 1");
    expect(res.results[0].exitCode).toBe(0);
    expect(res.results[0].status).toBe("success");

    expect(res.results[1].command).toBe(commands[1]);
    expect(res.results[1].stdout.trim()).toBe("step 2");
    expect(res.results[1].exitCode).toBe(0);
    expect(res.results[1].status).toBe("success");

    expect(res.success).toBe(true);
    expect(res.aggregatedLog).toContain("$ node -e \"console.log('step 1')\"");
    expect(res.aggregatedLog).toContain("step 1");
    expect(res.aggregatedLog).toContain("[Exit code: 0]");
    expect(res.aggregatedLog).toContain("$ node -e \"console.log('step 2')\"");
    expect(res.aggregatedLog).toContain("step 2");

    // Progress events should include start, chunks, finish, done
    expect(progressEvents.some((e) => e.type === "start")).toBe(true);
    expect(progressEvents.some((e) => e.type === "finish")).toBe(true);
    expect(progressEvents.some((e) => e.type === "done")).toBe(true);
  });

  it("records non-zero exit codes when a command fails", async () => {
    const commands = ['node -e "process.stderr.write(\'fail\'); process.exit(42)"'];

    const res = await runDebugCommands(tmpDir, commands);

    expect(res.results).toHaveLength(1);
    expect(res.results[0].exitCode).toBe(42);
    expect(res.results[0].status).toBe("failed");
    expect(res.results[0].stderr).toContain("fail");
    expect(res.success).toBe(false);
    expect(res.aggregatedLog).toContain("[Exit code: 42]");
  });
});
