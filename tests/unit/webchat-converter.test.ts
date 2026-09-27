import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `webchat` extractor, with the chat stubbed out.
 *
 * What is worth testing here is not the browser automation — that is a DOM
 * problem, exercised by hand against a real site — but the contract between a
 * chat reply and the filesystem: which paths may be written, what happens
 * when the reply is prose, a patch, or about a different document, and what
 * the document record says afterwards. Every one of those is a way a chat
 * model can write the wrong thing into the user's project.
 */
const userData = path.join(os.tmpdir(), `abpp-webchat-userdata-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: class {},
}));

const { convertDocumentsViaWebChat, conversionPrompt, planConversionWrite } =
  await import("../../src/main/services/webchat-converter");
const { parseResponse } = await import(
  "../../src/main/services/response-parser"
);
const { scanDocuments, markdownPathFor, slugFor } = await import(
  "../../src/main/services/document-scanner"
);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-webchat-"));
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "report.docx"), "fake docx bytes");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(userData, { recursive: true, force: true });
});

function replyFor(target: string, body: string): string {
  return [`File: ${target}`, "", "```markdown", body, "```"].join("\n");
}

describe("conversionPrompt", () => {
  it("names the exact target path and the figure and table rules", () => {
    const prompt = conversionPrompt({
      documentPath: "report.docx",
      targetPath: "converted/report-ab12cd/report-ab12cd.md",
    });
    expect(prompt).toContain("File: converted/report-ab12cd/report-ab12cd.md");
    expect(prompt).toContain("**Figure**");
    expect(prompt).toMatch(/markdown table/);
    // The prose rule matters as much as the format rule: a paraphrased
    // conversion silently changes what the corpus says.
    expect(prompt).toMatch(/verbatim/i);
  });
});

describe("planConversionWrite", () => {
  it("accepts the requested target and nothing else", async () => {
    const target = "converted/a/a.md";
    const parsed = await parseResponse(
      [
        replyFor(target, "# Good"),
        "",
        replyFor("converted/b/b.md", "# Unrequested"),
      ].join("\n"),
    );
    const plan = planConversionWrite(
      "# irrelevant",
      target,
      parsed,
    );
    expect(plan.content).toBe("# Good");
    expect(plan.refused[0]?.reason).toMatch(/not the requested target/);
  });

  it("refuses a path outside converted/ and says why", async () => {
    const parsed = await parseResponse(replyFor("src/app.ts", "// hi"));
    const plan = planConversionWrite("", "converted/a/a.md", parsed);
    expect(plan.content).toBeNull();
    expect(plan.problem).toMatch(/not the requested target/);
  });

  it("reports prose answers as unusable rather than writing nothing silently", async () => {
    const parsed = await parseResponse("Here is the markdown you asked for!");
    const plan = planConversionWrite(
      "Here is the markdown you asked for!",
      "converted/a/a.md",
      parsed,
    );
    expect(plan.content).toBeNull();
    expect(plan.problem).toMatch(/no `File:` block/);
  });
});

describe("convertDocumentsViaWebChat", () => {
  it("writes the reply into converted/ and records the conversion", async () => {
    const slug = slugFor("report.docx");
    const target = `converted/${slug}/${slug}.md`;
    const prompts: string[] = [];

    const result = await convertDocumentsViaWebChat({
      projectRoot: root,
      docPaths: ["report.docx"],
      target: "deepseek",
      onProgress: () => {},
      send: async (prompt) => {
        prompts.push(prompt);
        return {
          ok: true,
          attached: true,
          text: replyFor(
            target,
            ["# Report", "", "> **Figure**: a bar chart of yield by site."].join(
              "\n",
            ),
          ),
        };
      },
    });

    expect(result.failed).toEqual([]);
    const written = await fs.readFile(markdownPathFor(root, slug), "utf8");
    expect(written).toContain("**Figure**");
    // The prompt carries the same path the reply was checked against.
    expect(prompts[0]).toContain(`File: ${target}`);

    const scan = await scanDocuments(root);
    const entry = scan.documents.find((d) => d.path === "report.docx");
    expect(entry?.status).toBe("converted");
    expect(entry?.convertedExists).toBe(true);
  });

  it("records a failure when the reply cannot be used, and writes nothing", async () => {
    const slug = slugFor("report.docx");
    const result = await convertDocumentsViaWebChat({
      projectRoot: root,
      docPaths: ["report.docx"],
      target: "deepseek",
      onProgress: () => {},
      send: async () => ({
        ok: true,
        attached: true,
        text: "I could not read that file.",
      }),
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/Could not use the reply/);
    await expect(fs.stat(markdownPathFor(root, slug))).rejects.toThrow();

    const scan = await scanDocuments(root);
    expect(scan.documents[0]?.status).toBe("failed");
    expect(scan.documents[0]?.error).toMatch(/Could not use the reply/);
  });

  it("flags a conversion the model answered without seeing the document", async () => {
    const slug = slugFor("report.docx");
    const target = `converted/${slug}/${slug}.md`;
    const result = await convertDocumentsViaWebChat({
      projectRoot: root,
      docPaths: ["report.docx"],
      target: "deepseek",
      onProgress: () => {},
      send: async () => ({
        ok: true,
        // The site had no file input, so the model answered from the prompt
        // alone. The text still gets written — refusing it would throw away
        // work — but the record says it is not trustworthy.
        attached: false,
        text: replyFor(target, "# Best guess"),
      }),
    });

    expect(result.failed).toEqual([]);
    const scan = await scanDocuments(root);
    expect(scan.documents[0]?.error).toMatch(/without it/);
  });

  it("reports a chat that never answered", async () => {
    const result = await convertDocumentsViaWebChat({
      projectRoot: root,
      docPaths: ["report.docx"],
      target: "deepseek",
      onProgress: () => {},
      send: async () => ({ ok: false, attached: true, error: "Timed out." }),
    });
    expect(result.failed[0]?.error).toBe("Timed out.");
  });
});
