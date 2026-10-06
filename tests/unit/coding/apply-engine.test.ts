import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFiles, computeDiff } from "../../../src/main/services/coding/apply-engine";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "AnythingButProPlan-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("applyFiles", () => {
  it("creates new files, including parent directories", async () => {
    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "src/deep/new.ts", content: "export const a = 1\n" }],
    });

    expect(results).toEqual([{ path: "src/deep/new.ts", status: "created" }]);
    await expect(
      fs.readFile(path.join(root, "src/deep/new.ts"), "utf8"),
    ).resolves.toBe("export const a = 1\n");
  });

  it("overwrites a file and reports the status", async () => {
    const target = path.join(root, "app.ts");
    await fs.writeFile(target, "old\n", "utf8");

    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "app.ts", content: "new\n" }],
    });

    // Version history is Git's job. The applier writes the new content and
    // reports the status; there is no `.bak` sibling any more.
    expect(results[0]).toEqual({ path: "app.ts", status: "overwritten" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new\n");
  });

  it("leaves no backup sibling behind after repeated overwrites", async () => {
    const target = path.join(root, "app.ts");
    await fs.writeFile(target, "first\n", "utf8");
    await applyFiles({
      projectRoot: root,
      files: [{ path: "app.ts", content: "second\n" }],
    });
    await applyFiles({
      projectRoot: root,
      files: [{ path: "app.ts", content: "third\n" }],
    });

    // Git is the version history. The applier writes the new content and
    // nothing else — no `.bak` sibling, no dated snapshot, no `.tmp`.
    expect(await fs.readdir(root)).toEqual(["app.ts"]);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("third\n");
  });

  it("leaves no .tmp files behind", async () => {
    await applyFiles({
      projectRoot: root,
      files: [{ path: "a.ts", content: "x\n" }],
    });
    const names = await fs.readdir(root);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("skips a write whose content is unchanged", async () => {
    await fs.writeFile(path.join(root, "app.ts"), "same\n", "utf8");
    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "app.ts", content: "same\n" }],
    });

    expect(results).toEqual([{ path: "app.ts", status: "skipped" }]);
    await expect(fs.readdir(root)).resolves.toEqual(["app.ts"]);
  });

  it("rejects traversal without touching the filesystem", async () => {
    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "../escaped.ts", content: "nope\n" }],
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toMatch(/escapes the project root/);
    await expect(
      fs.access(path.join(root, "..", "escaped.ts")),
    ).rejects.toThrow();
  });

  it("rejects absolute paths outside the root", async () => {
    const results = await applyFiles({
      projectRoot: root,
      files: [
        { path: "/tmp/AnythingButProPlan-absolute.ts", content: "nope\n" },
      ],
    });

    expect(results[0]?.status).toBe("failed");
    await expect(
      fs.access("/tmp/AnythingButProPlan-absolute.ts"),
    ).rejects.toThrow();
  });

  it("rejects names Windows cannot create", async () => {
    const results = await applyFiles({
      projectRoot: root,
      files: [
        { path: "CON.ts", content: "nope\n" },
        { path: "src/trailing.", content: "nope\n" },
        { path: "src/we:ird.ts", content: "nope\n" },
      ],
    });

    expect(results.map((result) => result.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("reports a failure without rolling back the writes that succeeded", async () => {
    const results = await applyFiles({
      projectRoot: root,
      files: [
        { path: "good.ts", content: "ok\n" },
        { path: "../../bad.ts", content: "no\n" },
      ],
    });

    expect(results.map((result) => result.status)).toEqual([
      "created",
      "failed",
    ]);
    await expect(fs.readFile(path.join(root, "good.ts"), "utf8")).resolves.toBe(
      "ok\n",
    );
  });
});

describe("computeDiff", () => {
  it("returns empty original for a file that does not exist yet", async () => {
    const result = await computeDiff(root, "ghost.ts", "new\n");
    expect(result).toEqual({ original: "", modified: "new\n", exists: false });
  });

  it("returns the on-disk content for an existing file", async () => {
    await fs.writeFile(path.join(root, "app.ts"), "on disk\n", "utf8");
    const result = await computeDiff(root, "app.ts", "proposed\n");
    expect(result).toEqual({
      original: "on disk\n",
      modified: "proposed\n",
      exists: true,
    });
  });
});
