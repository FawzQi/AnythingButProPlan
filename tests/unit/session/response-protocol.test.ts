import { describe, expect, it } from "vitest";
import {
  parseNeeds,
  parsePlan,
  parseSessionResponse,
  sectionBody,
} from "../../../src/main/services/session/response-protocol";

describe("sectionBody", () => {
  it("returns undefined when the section is absent", () => {
    expect(sectionBody("nothing here", "Need")).toBeUndefined();
  });

  it("returns an empty string for a present but empty section", () => {
    const raw = "===Need===\n======\n";
    expect(sectionBody(raw, "Need")).toBe("");
  });

  it("stops at the next section opener", () => {
    const raw = ["===Plan===", "- [ ] a", "======", "===Need===", "src/a.ts", "======"].join("\n");
    expect(sectionBody(raw, "Plan")?.trim()).toBe("- [ ] a");
  });

  it("accepts the legacy heading dialect", () => {
    const raw = ["## Plan", "- [x] done", "## Notes", "whatever"].join("\n");
    expect(sectionBody(raw, "Plan")?.trim()).toBe("- [x] done");
  });
});

describe("parseNeeds", () => {
  it("parses one path per line", () => {
    const raw = ["===Need===", "src/a.ts", "src/b.ts", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("strips list markers and backticks", () => {
    const raw = ["===Need===", "- src/a.ts", "* `src/b.ts`", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("treats None as no request", () => {
    const raw = ["===Need===", "None", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual([]);
  });

  it("ignores prose lines", () => {
    const raw = ["===Need===", "I need to see the config file first", "src/a.ts", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual(["src/a.ts"]);
  });

  it("deduplicates", () => {
    const raw = ["===Need===", "src/a.ts", "src/a.ts", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual(["src/a.ts"]);
  });

  it("rejects traversal paths", () => {
    const raw = ["===Need===", "../secrets.env", "======"].join("\n");
    expect(parseNeeds(raw)).toEqual([]);
  });

  it("returns nothing when the section is absent", () => {
    expect(parseNeeds("===Files===\n======\n")).toEqual([]);
  });
});

describe("parsePlan", () => {
  it("parses checkbox statuses", () => {
    const raw = ["===Plan===", "- [x] done", "- [>] active", "- [ ] pending", "- [!] blocked", "======"].join("\n");
    expect(parsePlan(raw)?.map((step) => step.status)).toEqual([
      "done",
      "active",
      "pending",
      "blocked",
    ]);
  });

  it("accepts a numbered list as pending steps", () => {
    const raw = ["===Plan===", "1. first", "2. second", "======"].join("\n");
    expect(parsePlan(raw)?.map((step) => step.text)).toEqual(["first", "second"]);
  });

  it("returns null when absent, which means unchanged", () => {
    expect(parsePlan("===Files===\n======\n")).toBeNull();
  });

  it("returns null for None", () => {
    const raw = ["===Plan===", "None", "======"].join("\n");
    expect(parsePlan(raw)).toBeNull();
  });

  it("assigns stable ids", () => {
    const raw = ["===Plan===", "- [ ] a", "- [ ] b", "======"].join("\n");
    expect(parsePlan(raw)?.map((step) => step.id)).toEqual(["step-1", "step-2"]);
  });
});

describe("parseSessionResponse", () => {
  it("combines the base parse with needs and plan", () => {
    const raw = [
      "===Plan===",
      "- [>] write the helper",
      "======",
      "===Need===",
      "src/existing.ts",
      "======",
      "===Files===",
      "File: src/retry.ts",
      "```ts",
      "export const retry = () => {};",
      "```",
      "======",
      "===Explanation===",
      "Added a helper.",
      "======",
      "===Debug===",
      "None",
      "======",
    ].join("\n");

    const parsed = parseSessionResponse(raw);

    expect(parsed.needs).toEqual(["src/existing.ts"]);
    expect(parsed.plan?.[0]?.status).toBe("active");
    expect(parsed.files.some((file) => file.path === "src/retry.ts")).toBe(true);
  });

  it("still works with a legacy three-section response", () => {
    const raw = [
      "===Files===",
      "File: src/a.ts",
      "```ts",
      "export const a = 1;",
      "```",
      "======",
      "===Explanation===",
      "None",
      "======",
      "===Debug===",
      "None",
      "======",
    ].join("\n");

    const parsed = parseSessionResponse(raw);

    expect(parsed.needs).toEqual([]);
    expect(parsed.plan).toBeNull();
    expect(parsed.files).toHaveLength(1);
  });
});
