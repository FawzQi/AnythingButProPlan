import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  createGitCheckpoint,
  rollbackGitCheckpoint,
  rollbackGitCheckpointDetailed,
} from "../../../src/main/services/git/git-checkpoint";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("git-checkpoint", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-git-checkpoint-"));
    git(tempDir, ["init"]);
    git(tempDir, ["config", "user.email", "test@example.com"]);
    git(tempDir, ["config", "user.name", "Test User"]);
    await fs.writeFile(path.join(tempDir, "initial.txt"), "hello world\n", "utf8");
    git(tempDir, ["add", "."]);
    git(tempDir, ["commit", "-m", "initial commit"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates a checkpoint on clean working tree", async () => {
    const cp = await createGitCheckpoint(tempDir);
    expect(cp).toBeTruthy();
    expect(typeof cp).toBe("string");
  });

  it("returns null when the folder is not a git repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-no-git-"));
    try {
      expect(await createGitCheckpoint(plain)).toBeNull();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it("rolls back untracked and modified files created during run", async () => {
    const cp = await createGitCheckpoint(tempDir);
    expect(cp).toBeTruthy();

    await fs.writeFile(path.join(tempDir, "initial.txt"), "modified content\n", "utf8");
    await fs.writeFile(path.join(tempDir, "untracked.ts"), "const x = 1;\n", "utf8");

    expect(await fs.readFile(path.join(tempDir, "initial.txt"), "utf8")).toBe("modified content\n");

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await fs.readFile(path.join(tempDir, "initial.txt"), "utf8")).toBe("hello world\n");
    expect(await exists(path.join(tempDir, "untracked.ts"))).toBe(false);
  });

  it("leaves a pre-existing untracked file untouched", async () => {
    // The audit's data-loss scenario: a scratch note exists before the run.
    await fs.writeFile(path.join(tempDir, "scratch.md"), "my notes\n", "utf8");
    const cp = await createGitCheckpoint(tempDir);

    // The run edits a tracked file and creates a new one, then rolls back.
    await fs.writeFile(path.join(tempDir, "initial.txt"), "agent edit\n", "utf8");
    await fs.writeFile(path.join(tempDir, "created.ts"), "export {}\n", "utf8");

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await fs.readFile(path.join(tempDir, "scratch.md"), "utf8")).toBe("my notes\n");
    expect(await exists(path.join(tempDir, "created.ts"))).toBe(false);
    expect(await fs.readFile(path.join(tempDir, "initial.txt"), "utf8")).toBe("hello world\n");
  });

  it("restores a pre-existing untracked file the run deleted", async () => {
    await fs.mkdir(path.join(tempDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "notes", "todo.md"), "# todo\n", "utf8");
    const cp = await createGitCheckpoint(tempDir);

    await fs.rm(path.join(tempDir, "notes", "todo.md"));
    await fs.rmdir(path.join(tempDir, "notes"));

    const report = await rollbackGitCheckpointDetailed(tempDir, cp as string);

    expect(report.ok).toBe(true);
    expect(report.restoredUntracked).toEqual(["notes/todo.md"]);
    expect(await fs.readFile(path.join(tempDir, "notes", "todo.md"), "utf8")).toBe("# todo\n");
  });

  it("does not clobber a pre-existing untracked file the run modified", async () => {
    const target = path.join(tempDir, "scratch.md");
    await fs.writeFile(target, "before\n", "utf8");
    const cp = await createGitCheckpoint(tempDir);

    await fs.writeFile(target, "agent overwrote this\n", "utf8");

    const report = await rollbackGitCheckpointDetailed(tempDir, cp as string);

    expect(report.skippedModified).toEqual(["scratch.md"]);
    // Overwriting a post-snapshot manual edit would be worse than leaving it.
    expect(await fs.readFile(target, "utf8")).toBe("agent overwrote this\n");
  });

  it("restores staged-ness of tracked files", async () => {
    await fs.writeFile(path.join(tempDir, "initial.txt"), "staged edit\n", "utf8");
    git(tempDir, ["add", "initial.txt"]);
    const cp = await createGitCheckpoint(tempDir);

    await fs.writeFile(path.join(tempDir, "initial.txt"), "agent edit\n", "utf8");
    git(tempDir, ["add", "initial.txt"]);

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await fs.readFile(path.join(tempDir, "initial.txt"), "utf8")).toBe("staged edit\n");
    const status = git(tempDir, ["status", "--porcelain", "initial.txt"]);
    expect(status.startsWith("M ")).toBe(true);
  });

  it("keeps untracked files when the checkpoint has no manifest", async () => {
    const head = git(tempDir, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(tempDir, "scratch.md"), "notes\n", "utf8");

    const report = await rollbackGitCheckpointDetailed(tempDir, head);

    expect(await exists(path.join(tempDir, "scratch.md"))).toBe(true);
    expect(report.deleted).toEqual([]);
  });

  it("survives a pre-existing staged new file", async () => {
    await fs.writeFile(path.join(tempDir, "staged-new.ts"), "export const preexisting = 1;\n", "utf8");
    git(tempDir, ["add", "staged-new.ts"]);
    const cp = await createGitCheckpoint(tempDir);

    await fs.writeFile(path.join(tempDir, "staged-new.ts"), "export const agent = 2;\n", "utf8");

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await fs.readFile(path.join(tempDir, "staged-new.ts"), "utf8")).toBe(
      "export const preexisting = 1;\n",
    );
  });

  it("restores a pre-existing untracked file that the run staged", async () => {
    await fs.writeFile(path.join(tempDir, "loose.ts"), "const original = true;\n", "utf8");
    const cp = await createGitCheckpoint(tempDir);

    await fs.writeFile(path.join(tempDir, "loose.ts"), "const overwritten = true;\n", "utf8");
    git(tempDir, ["add", "loose.ts"]);

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await fs.readFile(path.join(tempDir, "loose.ts"), "utf8")).toBe(
      "const original = true;\n",
    );
    // It must not be left staged — it was untracked before the run.
    expect(git(tempDir, ["status", "--porcelain", "loose.ts"])).toContain("??");
  });

  it("deletes a file the run created and staged", async () => {
    const cp = await createGitCheckpoint(tempDir);

    await fs.writeFile(path.join(tempDir, "agent-new.ts"), "export const agent = 1;\n", "utf8");
    git(tempDir, ["add", "agent-new.ts"]);

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await exists(path.join(tempDir, "agent-new.ts"))).toBe(false);
    expect(git(tempDir, ["status", "--porcelain"])).toBe("");
  });

  it("removes empty directories left behind by a deleted untracked file", async () => {
    const cp = await createGitCheckpoint(tempDir);
    const nested = path.join(tempDir, "a", "b", "c.ts");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, "export {}\n", "utf8");

    expect(await rollbackGitCheckpoint(tempDir, cp as string)).toBe(true);

    expect(await exists(path.join(tempDir, "a"))).toBe(false);
  });
});
