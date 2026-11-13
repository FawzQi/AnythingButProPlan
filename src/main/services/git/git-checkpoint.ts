import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isRepository } from "./git-service";

/**
 * Checkpoint layout inside the repository's git directory (invisible to the
 * working tree, excluded from every commit):
 *
 *   <git-dir>/abpp/checkpoints/meta/<id>.json    checkpoint descriptor
 *   <git-dir>/abpp/checkpoints/files/<id>/<rel>  content backups of files that
 *                                                were untracked at snapshot time
 *
 * The backup directory is what makes rollback non-destructive: `git stash`
 * only records tracked files, so a pre-existing untracked file would otherwise
 * be either destroyed by a blanket `git clean` or impossible to restore after
 * the run overwrote it.
 */

/** Per-file cap for untracked content backups. Larger files are listed but not copied. */
const MAX_BACKUP_FILE_BYTES = 2 * 1024 * 1024;
/** Total cap for one checkpoint's untracked backups. */
const MAX_BACKUP_TOTAL_BYTES = 64 * 1024 * 1024;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CheckpointMeta {
  id: string;
  createdAt: number;
  /** Commit produced by `git stash create`, or null when only untracked files changed. */
  stashSha: string | null;
  /** HEAD at snapshot time, or null on an unborn branch. */
  headSha: string | null;
  /** Paths untracked (and not ignored) before the run started. */
  untracked: string[];
  /**
   * Every path in the index before the run started. Used to spot files the run
   * itself created and staged, which are no longer reported as untracked.
   */
  indexPaths: string[];
  /** Subset of `untracked` whose contents were copied into the checkpoint. */
  backedUp: string[];
  /** Subset of `untracked` skipped by the size caps. */
  notBackedUp: string[];
}

/**
 * `git` with a NUL-safe stdout: `ls-files -z` output must not be trimmed or
 * line-split, so this variant keeps the raw bytes and only strips a trailing
 * newline when the caller asks for it.
 */
function runGitRaw(root: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      resolve({ ok: false, code: null, stdout: "", stderr: err.message });
    });
  });
}

async function runGit(
  root: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runGitRaw(root, args);
  return { ok: result.ok, stdout: result.stdout.trim(), stderr: result.stderr };
}

/** Split NUL-delimited `git` path output into paths, dropping the empty tail. */
function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/** Absolute path of the checkpoint directory, honouring worktrees and `--git-dir`. */
async function checkpointsRoot(root: string): Promise<string | null> {
  const res = await runGit(root, ["rev-parse", "--git-path", "abpp/checkpoints"]);
  if (!res.ok || res.stdout === "") return null;
  return path.resolve(root, res.stdout);
}

function metaPath(dir: string, id: string): string {
  return path.join(dir, "meta", `${id}.json`);
}

function backupPath(dir: string, id: string, relativePath: string): string {
  // `relativePath` comes from git and is POSIX-style; normalize the separators
  // so the backup lands under the right directory on Windows too.
  return path.join(dir, "files", id, ...relativePath.split("/"));
}

/**
 * Reject a path that escapes its base directory. `git ls-files` never emits
 * `..` segments, but the backup path is built from strings and this is cheap
 * insurance against a malformed or hostile index.
 */
function assertContained(base: string, candidate: string): void {
  const relative = path.relative(base, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the checkpoint directory: ${candidate}`);
  }
}

/** Untracked, non-ignored paths currently in the working tree. */
async function listUntracked(root: string): Promise<string[]> {
  const res = await runGitRaw(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return res.ok ? splitNul(res.stdout) : [];
}

/**
 * Paths present in the index. Captured before the run so that a file the run
 * creates *and stages* is still recognised as run-created even though it no
 * longer appears in `ls-files --others`.
 */
async function listIndexPaths(root: string): Promise<string[]> {
  const res = await runGitRaw(root, ["ls-files", "--cached", "-z"]);
  return res.ok ? splitNul(res.stdout) : [];
}

/** Remove `relativePath` and any parent directories that became empty. */
async function removeFileAndEmptyParents(root: string, relativePath: string): Promise<void> {
  const absolute = path.resolve(root, relativePath);
  await fs.rm(absolute, { force: true, recursive: false });
  let dir = path.dirname(absolute);
  const stop = path.resolve(root);
  while (dir !== stop && dir.startsWith(stop) && dir !== path.dirname(dir)) {
    try {
      await fs.rmdir(dir);
    } catch {
      // Not empty, or gone already — either way there is nothing more to do.
      break;
    }
    dir = path.dirname(dir);
  }
}

async function writeMeta(dir: string, meta: CheckpointMeta): Promise<void> {
  await fs.mkdir(path.join(dir, "meta"), { recursive: true });
  const target = metaPath(dir, meta.id);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(meta, null, 2), "utf8");
  await fs.rename(temp, target);
}

async function readMeta(dir: string, id: string): Promise<CheckpointMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(dir, id), "utf8");
    const parsed = JSON.parse(raw) as Partial<CheckpointMeta>;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.untracked)) return null;
    return {
      id: parsed.id,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      stashSha: typeof parsed.stashSha === "string" ? parsed.stashSha : null,
      headSha: typeof parsed.headSha === "string" ? parsed.headSha : null,
      untracked: parsed.untracked.filter((entry): entry is string => typeof entry === "string"),
      indexPaths: Array.isArray(parsed.indexPaths)
        ? parsed.indexPaths.filter((entry): entry is string => typeof entry === "string")
        : [],
      backedUp: Array.isArray(parsed.backedUp)
        ? parsed.backedUp.filter((entry): entry is string => typeof entry === "string")
        : [],
      notBackedUp: Array.isArray(parsed.notBackedUp)
        ? parsed.notBackedUp.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function newCheckpointId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `abpp-${stamp}-${randomBytes(4).toString("hex")}`;
}

/**
 * Snapshot the working tree before an autonomous run.
 *
 * Returns an opaque checkpoint id, or null when the folder is not a Git
 * repository. The id is persisted alongside the session so a rollback can be
 * performed after an app restart.
 */
export async function createGitCheckpoint(root: string): Promise<string | null> {
  if (!(await isRepository(root))) return null;

  const dir = await checkpointsRoot(root);
  if (!dir) return null;

  const id = newCheckpointId();

  const headRes = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const headSha = headRes.ok && headRes.stdout !== "" ? headRes.stdout : null;

  // `git stash create` snapshots tracked changes (staged and unstaged) without
  // touching the index or the working tree. It necessarily ignores untracked
  // files — those are handled by the explicit backup below.
  let stashSha: string | null = null;
  if (headSha) {
    const stashRes = await runGit(root, ["stash", "create", "abpp-agent-checkpoint"]);
    if (stashRes.ok && stashRes.stdout !== "") stashSha = stashRes.stdout;
    // Pin the dangling stash commit so `git gc` cannot collect it before the
    // rollback window closes.
    if (stashSha) {
      await runGit(root, ["update-ref", `refs/abpp/checkpoints/${id}`, stashSha]);
    }
  }

  const untracked = await listUntracked(root);
  const indexPaths = await listIndexPaths(root);
  const backedUp: string[] = [];
  const notBackedUp: string[] = [];
  let totalBytes = 0;

  for (const relativePath of untracked) {
    const source = path.resolve(root, relativePath);
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile()) {
        notBackedUp.push(relativePath);
        continue;
      }
      if (stat.size > MAX_BACKUP_FILE_BYTES || totalBytes + stat.size > MAX_BACKUP_TOTAL_BYTES) {
        notBackedUp.push(relativePath);
        continue;
      }
      const target = backupPath(dir, id, relativePath);
      assertContained(path.join(dir, "files", id), target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      totalBytes += stat.size;
      backedUp.push(relativePath);
    } catch {
      notBackedUp.push(relativePath);
    }
  }

  await writeMeta(dir, {
    id,
    createdAt: Date.now(),
    stashSha,
    headSha,
    untracked,
    indexPaths,
    backedUp,
    notBackedUp,
  });

  return id;
}

/** Detailed rollback report. The boolean wrapper below is kept for callers that only need success. */
export interface CheckpointRollback {
  ok: boolean;
  /** Files deleted because the run created them. */
  deleted: string[];
  /** Pre-existing untracked files restored from the content backup. */
  restoredUntracked: string[];
  /** Pre-existing untracked files that exist but differ from the snapshot; left alone for inspection. */
  skippedModified: string[];
  errors: string[];
}

/**
 * Restore the tree to a checkpoint.
 *
 * Guarantees:
 *   - Only untracked paths that did **not** exist at snapshot time are deleted.
 *   - Pre-existing untracked files that the run deleted are restored from the
 *     content backup.
 *   - Pre-existing untracked files that the run modified are left in place and
 *     reported in `skippedModified`, because overwriting a post-snapshot manual
 *     edit would be a worse outcome than an incomplete rollback.
 *   - The pre-run dirty state of *tracked* files (including staged-ness) is
 *     re-applied from the stash commit.
 */
export async function rollbackGitCheckpointDetailed(
  root: string,
  checkpointId: string,
): Promise<CheckpointRollback> {
  const report: CheckpointRollback = {
    ok: false,
    deleted: [],
    restoredUntracked: [],
    skippedModified: [],
    errors: [],
  };

  if (!(await isRepository(root))) {
    report.errors.push("Not a Git repository.");
    return report;
  }

  const dir = await checkpointsRoot(root);
  if (!dir) {
    report.errors.push("Could not resolve the Git directory.");
    return report;
  }

  const meta = await readMeta(dir, checkpointId);

  // ---- 1. Tracked files back to HEAD --------------------------------------
  // `git reset --hard` restores tracked files and clears the index, but it
  // never touches untracked files — which is why it is used here instead of
  // `git clean` or a blanket `restore`. The pre-run dirty state (including
  // which changes were staged) is re-applied from the stash in step 4.
  let trackedRestored = true;
  if (meta?.headSha) {
    const reset = await runGit(root, ["reset", "--quiet", "--hard", meta.headSha]);
    if (!reset.ok) {
      trackedRestored = false;
      report.errors.push(reset.stderr || "Could not reset tracked files.");
    }
  } else if (meta) {
    // Unborn branch: there is no HEAD to reset to. Unstage everything and
    // leave file contents alone; the untracked logic below handles additions.
    await runGit(root, ["reset", "--quiet"]);
  }

  // ---- 2. Untracked delta: delete only what the run created ---------------
  const preexisting = new Set(meta?.untracked ?? []);
  const preexistingIndex = new Set(meta?.indexPaths ?? []);
  const currentUntracked = await listUntracked(root);

  if (meta) {
    // A run-created file is one that is neither pre-existing-untracked nor
    // pre-existing-in-the-index. Both checks are needed because an agent that
    // stages its own new file removes it from the untracked list.
    for (const relativePath of currentUntracked) {
      if (preexisting.has(relativePath) || preexistingIndex.has(relativePath)) continue;
      try {
        await removeFileAndEmptyParents(root, relativePath);
        report.deleted.push(relativePath);
      } catch (err) {
        report.errors.push(`Could not remove ${relativePath}: ${(err as Error).message}`);
      }
    }
  } else {
    // Legacy checkpoint (a bare stash/HEAD sha) with no manifest. Deleting
    // untracked files here could destroy pre-existing work, so don't.
    report.errors.push(
      "Checkpoint has no untracked-file manifest; untracked files were left in place.",
    );
  }

  // ---- 3. Restore pre-existing untracked contents -------------------------
  const backupRoot = path.join(dir, "files", checkpointId);
  for (const relativePath of meta?.backedUp ?? []) {
    const target = path.resolve(root, relativePath);
    assertContained(root, target);
    const source = backupPath(dir, checkpointId, relativePath);
    try {
      const expected = await fs.readFile(source);
      try {
        const actual = await fs.readFile(target);
        if (actual.equals(expected)) continue;
        // Present but different: the run (or the user) changed it after the
        // snapshot. Leave it and report rather than clobber.
        report.skippedModified.push(relativePath);
        continue;
      } catch {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, expected);
        report.restoredUntracked.push(relativePath);
      }
    } catch (err) {
      report.errors.push(`Could not restore ${relativePath}: ${(err as Error).message}`);
    }
  }

  // ---- 4. Re-apply the pre-run tracked state ------------------------------
  let stashReapplied = true;
  if (meta?.stashSha) {
    const withIndex = await runGit(root, [
      "stash",
      "apply",
      "--index",
      "--quiet",
      meta.stashSha,
    ]);
    if (!withIndex.ok) {
      // `--index` fails when the snapshot's staged state conflicts with the
      // restored tree; retry without it so the file contents still come back.
      const withoutIndex = await runGit(root, ["stash", "apply", "--quiet", meta.stashSha]);
      if (!withoutIndex.ok) {
        stashReapplied = false;
        report.errors.push(withIndex.stderr || withoutIndex.stderr || "Could not re-apply stash.");
      }
    }
  }

  if (report.errors.length === 0) {
    await runGit(root, ["update-ref", "-d", `refs/abpp/checkpoints/${checkpointId}`]);
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(metaPath(dir, checkpointId), { force: true }).catch(() => undefined);
  }

  report.ok = trackedRestored && stashReapplied && report.errors.length === 0;
  return report;
}

/**
 * Boolean form of {@link rollbackGitCheckpointDetailed}. Kept because the
 * agent IPC channel and its existing tests speak in terms of success/failure.
 */
export async function rollbackGitCheckpoint(
  root: string,
  checkpointId: string,
): Promise<boolean> {
  const report = await rollbackGitCheckpointDetailed(root, checkpointId);
  return report.ok;
}
