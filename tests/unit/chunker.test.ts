import { describe, expect, it } from "vitest";
import { countTokens } from "gpt-tokenizer";
import { chunkMarkdown, splitSections } from "../../src/main/services/chunker";

describe("splitSections", () => {
  it("builds a heading path from nested headings", () => {
    const sections = splitSections(
      ["# Paper", "intro text", "## 3 Methodology", "body", "### 3.2 Data", "more"].join(
        "\n",
      ),
    );
    expect(sections.map((section) => section.headingPath)).toEqual([
      "Paper",
      "Paper > 3 Methodology",
      "Paper > 3 Methodology > 3.2 Data",
    ]);
  });

  it("closes deeper headings when a shallower one appears", () => {
    const sections = splitSections(
      ["## A", "one", "### A.1", "two", "## B", "three"].join("\n"),
    );
    expect(sections.at(-1)?.headingPath).toBe("B");
  });

  it("does not treat a comment inside a fenced block as a heading", () => {
    const sections = splitSections(
      ["## Real", "```python", "# not a heading", "```", "after"].join("\n"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.headingPath).toBe("Real");
    expect(sections[0]?.text).toContain("# not a heading");
  });
});

describe("chunkMarkdown", () => {
  it("keeps chunks under the target size and carries the heading path", () => {
    const paragraph = "The sampling procedure was fixed across both studies. ";
    const markdown = `## 4 Results\n\n${paragraph.repeat(60)}`;
    const chunks = chunkMarkdown("paper.pdf", markdown, {
      tokens: 300,
      overlap: 50,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe("4 Results");
      // One sentence over the target is allowed (a sentence is never split),
      // so the bound is the sentence, not the target.
      expect(chunk.tokens).toBeLessThan(400);
      expect(chunk.tokens).toBe(countTokens(chunk.text));
    }
  });

  it("repeats the tail of one chunk at the head of the next", () => {
    const paragraph = "Sentence number one about sampling. ";
    const markdown = `## Methods\n\n${paragraph.repeat(80)}`;
    const chunks = chunkMarkdown("paper.pdf", markdown, {
      tokens: 100,
      overlap: 30,
    });

    expect(chunks.length).toBeGreaterThan(2);
    // The last sentence of a chunk is carried into the next one, which is
    // what keeps a claim and its qualifier together across a boundary.
    const lastSentence = (chunks[0]?.text ?? "").trim().split(". ").at(-1) ?? "";
    expect(chunks[1]?.text).toContain(lastSentence.replace(/\.$/, ""));
  });

  it("numbers chunks across the whole document, not per section", () => {
    const chunks = chunkMarkdown(
      "paper.pdf",
      `## A\n\nalpha text\n\n## B\n\nbeta text`,
    );
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      "paper.pdf#0",
      "paper.pdf#1",
    ]);
  });
});
