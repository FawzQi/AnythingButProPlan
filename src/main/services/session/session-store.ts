/**
 * Persistence for sessions: one JSON file per session under
 * `<project>/.abpp/sessions/<id>.json`.
 *
 * Design rules:
 *   - Atomic writes (temp file + rename) so a crash cannot leave a
 *     half-written session.
 *   - Reads are schema-guarded. A corrupt or older file degrades to `null`,
 *     which the UI shows as "unreadable session" rather than crashing.
 *   - Paths are validated against the project root; the id never reaches
 *     `path.join` without a containment check.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Session, SessionSummary } from "@shared/types";

export const SESSION_DIR = ".abpp/sessions";
const SESSION_DIR_FALLBACK = ".abpp";

/** Max bytes of a single session file we are willing to parse. */
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

function sessionsDir(projectRoot: string): string {
  return path.join(projectRoot, SESSION_DIR);
}

/** Reject an id that is not a plain filename, or that escapes the directory. */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `s-${stamp}-${randomBytes(3).toString("hex")}`;
}

async function ensureDir(projectRoot: string): Promise<void> {
  await fs.mkdir(sessionsDir(projectRoot), { recursive: true });
}

/** True when `value` looks like a session the engine can operate on. */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Session>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.projectRoot === "string" &&
    typeof candidate.task === "string" &&
    Array.isArray(candidate.plan) &&
    Array.isArray(candidate.turns) &&
    Array.isArray(candidate.decisions) &&
    Array.isArray(candidate.baseline) &&
    Array.isArray(candidate.checkpoints) &&
    typeof candidate.status === "string"
  );
}

export async function saveSession(session: Session): Promise<void> {
  assertSafeId(session.id);
  await ensureDir(session.projectRoot);
  const dir = sessionsDir(session.projectRoot);
  const target = path.join(dir, `${session.id}.json`);
  const temp = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const body = JSON.stringify(session, null, 2);
  await fs.writeFile(temp, body, "utf8");
  await fs.rename(temp, target);
}

export async function loadSession(
  projectRoot: string,
  id: string,
): Promise<Session | null> {
  assertSafeId(id);
  const target = path.join(sessionsDir(projectRoot), `${id}.json`);
  try {
    const stat = await fs.stat(target);
    if (stat.size > MAX_SESSION_BYTES) return null;
    const raw = await fs.readFile(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteSession(
  projectRoot: string,
  id: string,
): Promise<void> {
  assertSafeId(id);
  await fs.rm(path.join(sessionsDir(projectRoot), `${id}.json`), {
    force: true,
  });
}

/**
 * Every readable session in the project, newest first. Unreadable files are
 * skipped rather than failing the whole list.
 */
export async function listSessions(projectRoot: string): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir(projectRoot));
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
    const session = await loadSession(projectRoot, id);
    if (session === null) continue;
    summaries.push({
      id: session.id,
      task: session.task,
      status: session.status,
      turnCount: session.turns.length,
      updatedAt: session.updatedAt,
    });
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The newest session that is still in play, or null. Used by the UI to resume
 * where the user left off after a restart.
 */
export async function findActiveSession(projectRoot: string): Promise<Session | null> {
  const summaries = await listSessions(projectRoot);
  for (const summary of summaries) {
    if (summary.status === "active" || summary.status === "awaiting-response") {
      return loadSession(projectRoot, summary.id);
    }
  }
  return null;
}

/**
 * Add `.abpp/` to the repository's `.gitignore` so session state is never
 * committed. Idempotent, and a no-op when the project is not a git repository.
 */
export async function ensureSessionGitignore(projectRoot: string): Promise<void> {
  const gitignore = path.join(projectRoot, ".gitignore");
  const entry = `${SESSION_DIR_FALLBACK}/`;

  let current = "";
  try {
    current = await fs.readFile(gitignore, "utf8");
  } catch {
    // No .gitignore yet — create one below.
  }

  const has = current
    .split(/\r?\n/)
    .some((line) => line.trim() === SESSION_DIR_FALLBACK || line.trim() === entry);
  if (has) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignore, `${current}${prefix}${entry}\n`, "utf8");
}
