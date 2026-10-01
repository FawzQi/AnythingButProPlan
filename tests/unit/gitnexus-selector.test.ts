import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The shared recall half of the file-suggestion pipelines.
 *
 * `suggestFilesGitNexusOnly` is the local-only variant — GitNexus graph
 * query (absent when the CLI is not on PATH), BM25 over a shallow file
 * preview, git-history reranking, and no provider call. The other two
 * variants add a precision stage on top of the *same* front half through
 * the private `recall` helper in this module, so exercising the local-only
 * pipeline end to end is what proves the shared call graph actually runs.
 *
 * `electron` is stubbed because the settings module the selector imports
 * reaches for `app.getPath` at module scope. `net.fetch` is stubbed so a
 * misplaced call would fail loudly rather than hang.
 */
const userData = path.join(os.tmpdir(), `abpp-gitnexus-userdata-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
  net: {
    fetch: () => Promise.reject(new Error("network disabled in tests")),
  },
}));

const { suggestFilesGitNexusOnly } = await import(
  "../../src/main/services/gitnexus-selector"
);

// Skip the whole suite when git is unavailable — every assertion depends on
// a real repository. The environment this runs in is CI and a dev box, both
// of which ship git; the skip is a courtesy to any place that does not.
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let root: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

describe.skipIf(!hasGit)("suggestFilesGitNexusOnly", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-gitnexus-"));
    git(["init"]);
    // A fresh temp repo has no identity; commit would refuse without one.
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "auth.ts"),
      "export function login() { return true }\n",
    );
    await fs.writeFile(
      path.join(root, "src", "session.ts"),
      "export function createSession() { return {}\n}\n",
    );
    await fs.writeFile(
      path.join(root, "src", "unrelated.ts"),
      "export function doThing() { return 1 }\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "initial"]);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  });

  it("ranks keyword-matched files above recency-only candidates", async () => {
    const suggestion = await suggestFilesGitNexusOnly(
      {
        projectRoot: root,
        filePaths: ["src/auth.ts", "src/session.ts", "src/unrelated.ts"],
        instruction: "fix the auth session",
      },
      "deepseek",
    );

    // The recall front half — git context, tokenization, BM25, aggregation —
    // ran end to end and produced a real candidate list.
    expect(suggestion.method).toBe("gitnexus-only");
    expect(suggestion.candidateCount).toBeGreaterThan(0);
    expect(suggestion.paths).toContain("src/auth.ts");
    expect(suggestion.paths).toContain("src/session.ts");

    // `unrelated.ts` was committed in the same initial commit, so it gets a
    // recency bump and enters the candidate pool. It must not outrank a
    // file that also matched a keyword — the whole point of the BM25 half.
    const authRank = suggestion.paths.indexOf("src/auth.ts");
    const unrelatedRank = suggestion.paths.indexOf("src/unrelated.ts");
    expect(authRank).toBeGreaterThanOrEqual(0);
    expect(authRank).toBeLessThan(unrelatedRank);
  });

  it("populates a purpose string for every returned path", async () => {
    const suggestion = await suggestFilesGitNexusOnly(
      {
        projectRoot: root,
        filePaths: ["src/auth.ts", "src/session.ts", "src/unrelated.ts"],
        instruction: "auth",
      },
      "deepseek",
    );

    // The UI renders `purposes[path]` next to each selected file. An empty
    // string would show as a blank explanation in the selection banner,
    // which reads as a bug even when the selection itself is correct.
    for (const filePath of suggestion.paths) {
      expect(suggestion.purposes[filePath]).toBeTruthy();
    }
  });

  it("reports zero provider tokens — nothing was sent to a model", async () => {
    const suggestion = await suggestFilesGitNexusOnly(
      {
        projectRoot: root,
        filePaths: ["src/auth.ts", "src/session.ts", "src/unrelated.ts"],
        instruction: "auth",
      },
      "deepseek",
    );

    // The local-only pipeline never opens a socket. Reporting a non-zero
    // token count here would misrepresent the cost of the operation.
    expect(suggestion.mapTokens).toBe(0);
    expect(suggestion.outputTokens).toBe(0);
    expect(suggestion.model).toBe("local search");
  });

  it("falls back to the recency signal when no keyword matches", async () => {
    const suggestion = await suggestFilesGitNexusOnly(
      {
        projectRoot: root,
        filePaths: ["src/auth.ts", "src/session.ts", "src/unrelated.ts"],
        instruction: "zzzznonexistent",
      },
      "deepseek",
    );

    // No term matched any file, but every file was recently committed. The
    // recency boost is a real signal — the files the user touched last are
    // the files most likely to be relevant to the next change — so the
    // pipeline returns them even without a keyword hit, and the purpose
    // string says so.
    expect(suggestion.paths.length).toBeGreaterThan(0);
    for (const filePath of suggestion.paths) {
      expect(suggestion.purposes[filePath]).toMatch(/recent/);
    }
  });
});