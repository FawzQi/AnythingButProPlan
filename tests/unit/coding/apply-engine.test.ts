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

describe("size-collapse guard", () => {
  it("refuses a full rewrite that keeps less than 40% of a large file", async () => {
    const original = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    await fs.writeFile(path.join(root, "big.ts"), original, "utf8");

    const truncated = "export const v0 = 0;\nexport const v1 = 1;\n";

    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "big.ts", content: truncated }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("cut off");
    // The file on disk is untouched.
    await expect(fs.readFile(path.join(root, "big.ts"), "utf8")).resolves.toBe(original);
  });

  it("allows a modest shrink of a large file", async () => {
    const original = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    await fs.writeFile(path.join(root, "big.ts"), original, "utf8");

    const rewritten = original.split("\n").slice(0, 70).join("\n");

    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "big.ts", content: rewritten }],
    });

    expect(results[0]?.status).toBe("overwritten");
  });

  it("does not guard files below the line threshold", async () => {
    await fs.writeFile(path.join(root, "small.ts"), "a\nb\nc\nd\n", "utf8");

    const results = await applyFiles({
      projectRoot: root,
      files: [{ path: "small.ts", content: "a\n" }],
    });

    expect(results[0]?.status).toBe("overwritten");
    await expect(fs.readFile(path.join(root, "small.ts"), "utf8")).resolves.toBe("a\n");
  });
});

describe("applyFiles atomic mode", () => {
  it("writes nothing when any entry is invalid", async () => {
    await fs.writeFile(path.join(root, "good.ts"), "export const g = 1\n", "utf8");

    const results = await applyFiles({
      projectRoot: root,
      atomic: true,
      files: [
        { path: "good.ts", content: "export const g = 2\n" },
        { path: "missing.ts", content: "export const m = 1\n", patches: [{ search: "x", replace: "y" }] },
      ],
    });

    // The good entry is reported as skipped, not written.
    const good = results.find((result) => result.path === "good.ts");
    expect(good?.status).toBe("skipped");
    await expect(fs.readFile(path.join(root, "good.ts"), "utf8")).resolves.toBe(
      "export const g = 1\n",
    );

    // The missing target is the real failure.
    const missing = results.find((result) => result.path === "missing.ts");
    expect(missing?.status).toBe("failed");
    expect(missing?.error).toContain("does not exist");
  });

  it("writes every entry when all of them resolve", async () => {
    const results = await applyFiles({
      projectRoot: root,
      atomic: true,
      files: [
        { path: "a.ts", content: "export const a = 1\n" },
        { path: "b.ts", content: "export const b = 1\n" },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(["created", "created"]);
    await expect(fs.readFile(path.join(root, "a.ts"), "utf8")).resolves.toBe("export const a = 1\n");
    await expect(fs.readFile(path.join(root, "b.ts"), "utf8")).resolves.toBe("export const b = 1\n");
  });

  it("applies patches in memory and writes the patched result", async () => {
    await fs.writeFile(path.join(root, "p.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

    const results = await applyFiles({
      projectRoot: root,
      atomic: true,
      files: [
        { path: "p.ts", content: "", patches: [{ search: "const a = 1;", replace: "const a = 9;" }] },
      ],
    });

    expect(results[0]?.status).toBe("patched");
    await expect(fs.readFile(path.join(root, "p.ts"), "utf8")).resolves.toBe(
      "const a = 9;\nconst b = 2;\n",
    );
  });

  it("blocks a size-collapse entry before writing anything else", async () => {
    const big = Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    await fs.writeFile(path.join(root, "big.ts"), big, "utf8");

    const results = await applyFiles({
      projectRoot: root,
      atomic: true,
      files: [
        { path: "small.ts", content: "export const s = 1\n" },
        { path: "big.ts", content: "export const v0 = 0;\n" },
      ],
    });

    expect(results.find((result) => result.path === "small.ts")?.status).toBe("skipped");
    await expect(fs.readFile(path.join(root, "big.ts"), "utf8")).resolves.toBe(big);
    await expect(fs.access(path.join(root, "small.ts"))).rejects.toThrow();
  });
});
