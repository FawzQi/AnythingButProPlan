import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../../src/shared/types";
import {
  deleteSession,
  ensureSessionGitignore,
  findActiveSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
} from "../../../src/main/services/session/session-store";

function makeSession(projectRoot: string, overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: newSessionId(),
    projectRoot,
    task: "add a retry helper",
    createdAt: now,
    updatedAt: now,
    plan: [],
    turns: [],
    decisions: [],
    baseline: [],
    checkpoints: [],
    status: "active",
    contextBudget: 60_000,
    suppliedPaths: [],
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-session-store-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("session-store", () => {
  it("round-trips a session", async () => {
    const session = makeSession(root);
    await saveSession(session);

    const loaded = await loadSession(root, session.id);
    expect(loaded).toEqual(session);
  });

  it("returns null for a missing session", async () => {
    expect(await loadSession(root, "s-nope")).toBeNull();
  });

  it("returns null for corrupt JSON instead of throwing", async () => {
    const session = makeSession(root);
    await saveSession(session);
    await fs.writeFile(path.join(root, ".abpp/sessions", `${session.id}.json`), "{not json");

    expect(await loadSession(root, session.id)).toBeNull();
  });

  it("returns null for a file that parses but is not a session", async () => {
    const dir = path.join(root, ".abpp/sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s-bogus.json"), JSON.stringify({ hello: "world" }));

    expect(await loadSession(root, "s-bogus")).toBeNull();
  });

  it("refuses an id that would escape the session directory", async () => {
    await expect(loadSession(root, "../../etc/passwd")).rejects.toThrow(/Invalid session id/);
  });

  it("lists sessions newest first and skips unreadable files", async () => {
    const older = makeSession(root, { updatedAt: 1_000 });
    const newer = makeSession(root, { updatedAt: 2_000 });
    await saveSession(older);
    await saveSession(newer);
    await fs.writeFile(path.join(root, ".abpp/sessions", "broken.json"), "nope");

    const summaries = await listSessions(root);

    expect(summaries.map((summary) => summary.id)).toEqual([newer.id, older.id]);
  });

  it("returns an empty list when the directory does not exist", async () => {
    expect(await listSessions(path.join(root, "empty"))).toEqual([]);
  });

  it("finds the newest in-play session", async () => {
    const done = makeSession(root, { status: "green", updatedAt: 5_000 });
    const active = makeSession(root, { status: "awaiting-response", updatedAt: 1_000 });
    await saveSession(done);
    await saveSession(active);

    const found = await findActiveSession(root);
    expect(found?.id).toBe(active.id);
  });

  it("deletes a session", async () => {
    const session = makeSession(root);
    await saveSession(session);
    await deleteSession(root, session.id);
    expect(await loadSession(root, session.id)).toBeNull();
  });

  it("is not vulnerable to a partial write leaving invalid JSON", async () => {
    // The temp-then-rename write means the target is either absent or complete.
    const session = makeSession(root);
    await Promise.all([saveSession(session), saveSession(session)]);
    expect(await loadSession(root, session.id)).not.toBeNull();
  });
});

describe("ensureSessionGitignore", () => {
  it("creates .gitignore with the session directory", async () => {
    await ensureSessionGitignore(root);
    const contents = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(contents).toContain(".abpp/");
  });

  it("appends without clobbering existing rules", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await ensureSessionGitignore(root);
    const contents = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(contents).toContain("node_modules/");
    expect(contents).toContain(".abpp/");
  });

  it("is idempotent", async () => {
    await ensureSessionGitignore(root);
    await ensureSessionGitignore(root);
    const contents = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(contents.match(/\.abpp\//g)).toHaveLength(1);
  });

  it("adds a newline before appending when the file lacks one", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/");
    await ensureSessionGitignore(root);
    const contents = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(contents.startsWith("node_modules/\n.abpp/\n")).toBe(true);
  });
});
