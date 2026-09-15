import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDirectory } from "../../src/main/services/fs-service";
import { buildPrompt } from "../../src/main/services/prompt-builder";
import { parseResponse } from "../../src/main/services/response-parser";
import {
  collectSelectedPaths,
  setSubtreeSelected,
} from "../../src/renderer/lib/tree";

const FILES: Record<string, string> = {
  "src/app.ts":
    "import { helper } from './utils/helper'\n\nexport const app = () => helper()\n",
  "src/utils/helper.ts": "export const helper = () => 41\n",
  "README.md": "# Fixture\n\nA tiny project.\n",
  "crlf.ts": "const a = 1\r\nconst b = 2\r\n",
  "ignored.log": "noise\n",
  "node_modules/pkg/index.js": "module.exports = {}\n",
  ".gitignore": "ignored.log\n",
};

const SKIPPED = ["ignored.log", "node_modules", "image.png"];

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "LARPGent-roundtrip-"));
  for (const [relative, content] of Object.entries(FILES)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  // A binary file that the null-byte probe must catch.
  await fs.writeFile(
    path.join(root, "image.png"),
    Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("codebase -> prompt -> code", () => {
  it("scans, prompts, and parses back byte-for-byte", async () => {
    const scan = await scanDirectory(root);

    const selected = collectSelectedPaths(
      setSubtreeSelected(scan.tree, true),
    ).sort();
    expect(selected).toEqual([
      ".gitignore",
      "README.md",
      "crlf.ts",
      "src/app.ts",
      "src/utils/helper.ts",
    ]);
    for (const skipped of SKIPPED) {
      expect(selected.some((file) => file.includes(skipped))).toBe(false);
    }

    const built = await buildPrompt(root, selected);
    expect(built.unreadable).toEqual([]);
    expect(built.fileCount).toBe(selected.length);
    expect(built.tokenCount).toBeGreaterThan(0);

    // The prompt already carries the format we ask the model to reply with, so
    // echoing it back is the mock AI. The prompt's own Project Structure fence
    // is a snippet with no File: header, so exactly one block is skipped.
    const parsed = parseResponse(built.prompt);

    expect(parsed.strategy).toBe("markdown");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.files.map((file) => file.path).sort()).toEqual(selected);
    for (const file of parsed.files) {
      expect(file.content).toBe(FILES[file.path as string]);
    }
  });

  it("reports the tree the prompt advertises", async () => {
    const scan = await scanDirectory(root);
    const selected = collectSelectedPaths(
      setSubtreeSelected(scan.tree, true),
    ).sort();
    const built = await buildPrompt(root, selected);

    expect(built.prompt).toContain("## Project Structure");
    expect(built.prompt).toContain("├── app.ts");
    expect(built.prompt).toContain("└── helper.ts");
    expect(built.prompt).not.toContain("File: ignored.log");
    expect(built.prompt).not.toContain("node_modules");
    expect(built.prompt).not.toContain("image.png");
    expect(built.tokenCount).toBeLessThan(100_000);
  });
});
