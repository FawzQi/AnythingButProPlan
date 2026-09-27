import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end over the parts of research mode that need no provider: the
 * document scan, the markdown passthrough conversion, the state file, the
 * gitignore housekeeping, and the whole-document prompt.
 *
 * The PDF path is deliberately not covered here — it shells out to Marker,
 * which is not installed in CI and is not what this test is protecting. What
 * it protects is everything downstream of extraction, which is where the
 * plumbing bugs live. The PDF branch is exercised by the acceptance test in
 * CLAUDE.md.
 *
 * `electron` is stubbed because the settings module the scanner chain pulls
 * in reads `app.getPath` at call time.
 */
const userData = path.join(os.tmpdir(), `abpp-research-userdata-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { scanDocuments, ensureGitignore, slugFor, markdownPathFor } = await import(
  "../../src/main/services/document-scanner"
);
const { convertDocuments } = await import(
  "../../src/main/services/document-converter"
);
const { buildResearchPrompt } = await import(
  "../../src/main/services/research-prompt"
);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-research-"));
  await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(userData, { recursive: true, force: true });
});

describe("scanDocuments", () => {
  it("lists markdown and reports a file no engine can read", async () => {
    await fs.writeFile(path.join(root, "docs", "notes.md"), "# Notes\n\nhi\n");
    await fs.writeFile(path.join(root, "docs", "archive.bin"), "\x00\x01");

    const scan = await scanDocuments(root);
    const byPath = new Map(scan.documents.map((d) => [d.path, d]));

    expect(scan.docsDirExists).toBe(true);
    expect(byPath.get("notes.md")?.status).toBe("ready");
    expect(byPath.get("archive.bin")?.status).toBe("failed");
    expect(byPath.get("archive.bin")?.error).toMatch(/Unsupported format/);
  });

  it("keeps a chat-only format convertible rather than marking it failed", async () => {
    // A .docx has a working engine (webchat). Painting it red would tell the
    // user their document is unsupported when it is not.
    await fs.writeFile(path.join(root, "docs", "report.docx"), "fake");
    const scan = await scanDocuments(root);
    const entry = scan.documents.find((d) => d.path === "report.docx");
    expect(entry?.status).toBe("ready");
    expect(entry?.error).toMatch(/webchat extractor/);
  });

  it("reports a missing docs/ directory rather than an empty list", async () => {
    await fs.rm(path.join(root, "docs"), { recursive: true, force: true });
    const scan = await scanDocuments(root);
    expect(scan.docsDirExists).toBe(false);
    expect(scan.sourceDir).toBe("root");
    expect(scan.documents).toEqual([]);
  });

  it("falls back to the project root when there is no docs/ folder", async () => {
    // The case that prompted this: a folder full of papers opened directly,
    // with no docs/ subdirectory to move them into.
    await fs.rm(path.join(root, "docs"), { recursive: true, force: true });
    await fs.writeFile(path.join(root, "paper.pdf"), "%PDF-1.4\n");
    await fs.writeFile(path.join(root, "notes.md"), "# notes\n");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(root, "node_modules", "pkg", "README.md"),
      "# a package readme\n",
    );

    const scan = await scanDocuments(root);
    expect(scan.sourceDir).toBe("root");
    expect(scan.documents.map((d) => d.path)).toEqual(["notes.md", "paper.pdf"]);
    // A folder of code must not turn into a document list.
    expect(scan.documents.some((d) => d.path.includes("node_modules"))).toBe(
      false,
    );
  });

  it("uses docs/ once it exists, ignoring documents in the root", async () => {
    await fs.writeFile(path.join(root, "loose.pdf"), "%PDF-1.4\n");
    await fs.writeFile(path.join(root, "docs", "kept.md"), "# kept\n");
    const scan = await scanDocuments(root);
    expect(scan.sourceDir).toBe("docs");
    expect(scan.documents.map((d) => d.path)).toEqual(["kept.md"]);
  });

  it("gives distinct slugs to same-named files in different folders", () => {
    expect(slugFor("intro.pdf")).not.toBe(slugFor("nested/intro.pdf"));
  });
});

describe("convertDocuments", () => {
  it("writes markdown, records the state, and reports per-document failure", async () => {
    await fs.writeFile(path.join(root, "docs", "notes.md"), "# Notes\n\nbody\n");
    await fs.writeFile(path.join(root, "docs", "archive.bin"), "\x00\x01");

    const progress: string[] = [];
    const result = await convertDocuments({
      projectRoot: root,
      docPaths: [],
      mode: "text",
      engine: "auto",
      webChatTarget: "deepseek",
      onProgress: (entry) => progress.push(`${entry.path}:${entry.stage}`),
    });

    const notes = result.documents.find((d) => d.path === "notes.md");
    expect(notes?.status).toBe("converted");
    expect(notes?.convertedExists).toBe(true);
    expect(progress).toContain("notes.md:saving");

    // The unsupported file is in `failed`, not missing from the result.
    expect(result.failed.map((f) => f.path)).toEqual(["archive.bin"]);

    // State survives to disk, so the next scan sees the conversion.
    const slug = notes?.slug ?? "";
    const markdown = await fs.readFile(markdownPathFor(root, slug), "utf8");
    expect(markdown).toContain("body");

    const rescan = await scanDocuments(root);
    expect(rescan.documents.find((d) => d.path === "notes.md")?.status).toBe(
      "converted",
    );

    const state = JSON.parse(
      await fs.readFile(path.join(root, "converted", ".state.json"), "utf8"),
    ) as Record<string, { status: string }>;
    expect(state[slug]?.status).toBe("converted");
  });
});

describe("conversion engine guards", () => {
  it("refuses a text-images conversion on the fast engine", async () => {
    // The fast extractor has no layout model, so it cannot say which figure
    // belongs to which caption. Recording the document as `text-images` with
    // no descriptions would look converted and silently lose every figure.
    // The dummy file never reaches the extractor — the guard runs first.
    await fs.writeFile(path.join(root, "docs", "paper.pdf"), "not a real pdf\n");

    const result = await convertDocuments({
      projectRoot: root,
      docPaths: [],
      mode: "text-images",
      engine: "fast",
      webChatTarget: "deepseek",
      onProgress: () => {},
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/does not extract figures/);
    expect(result.documents[0]?.convertedExists).toBe(false);
  });
});

describe("ensureGitignore", () => {
  it("adds both derived directories once and is idempotent", async () => {
    expect(await ensureGitignore(root)).toBe(true);
    const first = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(first).toContain("converted/");
    expect(first).toContain(".index/");

    expect(await ensureGitignore(root)).toBe(false);
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(first);
  });

  it("keeps the existing entries", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await ensureGitignore(root);
    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(content.startsWith("node_modules/\n")).toBe(true);
  });
});

describe("buildResearchPrompt in full mode", () => {
  it("inlines every converted document and reports the unreadable ones", async () => {
    await fs.writeFile(
      path.join(root, "docs", "a.md"),
      "# Paper A\n\n## 1 Intro\n\nalpha finding\n",
    );
    await fs.writeFile(
      path.join(root, "docs", "b.md"),
      "# Paper B\n\n## 1 Intro\n\nbeta finding\n",
    );
    await convertDocuments({
      projectRoot: root,
      docPaths: [],
      mode: "text",
      engine: "auto",
      webChatTarget: "deepseek",
      onProgress: () => {},
    });

    const result = await buildResearchPrompt({
      projectRoot: root,
      mode: "full",
      docPaths: [],
      question: "How do they differ?",
    });

    expect(result.documentCount).toBe(2);
    expect(result.prompt).toContain("alpha finding");
    expect(result.prompt).toContain("beta finding");
    expect(result.prompt).toContain("How do they differ?");
    expect(result.tokenCount).toBeGreaterThan(0);

    // A selected document with no converted markdown is reported, never
    // silently dropped from the prompt.
    await fs.writeFile(path.join(root, "docs", "c.md"), "# Paper C\n\n");
    const withUnconverted = await buildResearchPrompt({
      projectRoot: root,
      mode: "full",
      docPaths: ["a.md", "c.md"],
      question: "?",
    });
    expect(withUnconverted.unreadable).toEqual(["c.md"]);
    expect(withUnconverted.documentCount).toBe(1);
  });

  it("accepts an empty question in full mode", async () => {
    // The renderer always sends the question field, empty in full mode. A
    // validator that treats "empty" as "invalid" rejects a legitimate build
    // before the mode-aware check ever runs.
    await fs.writeFile(path.join(root, "docs", "a.md"), "# A\n\n## 1\nalpha\n");
    await convertDocuments({
      projectRoot: root,
      docPaths: [],
      mode: "text",
      engine: "auto",
      webChatTarget: "deepseek",
      onProgress: () => {},
    });

    const result = await buildResearchPrompt({
      projectRoot: root,
      mode: "full",
      docPaths: [],
      question: "",
    });
    expect(result.documentCount).toBe(1);
    expect(result.prompt).toContain("alpha");
  });

  it("refuses a RAG prompt with no question instead of retrieving nothing", async () => {
    await fs.writeFile(path.join(root, "docs", "a.md"), "# A\n\ntext\n");
    await convertDocuments({
      projectRoot: root,
      docPaths: [],
      mode: "text",
      engine: "auto",
      webChatTarget: "deepseek",
      onProgress: () => {},
    });
    await expect(
      buildResearchPrompt({
        projectRoot: root,
        mode: "rag",
        docPaths: [],
        question: "   ",
      }),
    ).rejects.toThrow(/needs a question/i);
  });
});
