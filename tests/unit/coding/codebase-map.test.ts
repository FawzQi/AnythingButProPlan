import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodebaseMap,
  classifyFile,
} from "../../../src/main/services/coding/codebase-map";

/**
 * Coverage for the `FileSkeleton` discriminated union.
 *
 * The three variants (`asset`, `code`, and the config/data/doc family) each
 * produce a distinct header in the map text and a distinct body shape:
 * `asset` is a bare path, `code` has a `deps:` line and signature lines,
 * and the config-family has the `  ---` separator followed by a preview.
 * Each of those differences is what the union encodes in the type system,
 * so the map text is where the invariants surface and where the tests can
 * see them without reaching into private types.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-map-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("classifyFile", () => {
  it("tags assets, code, config, and doc by extension", () => {
    expect(classifyFile("logo.png")).toBe("asset");
    // The lockfile and minified heuristics run before the extension table.
    expect(classifyFile("app.min.js")).toBe("asset");
    expect(classifyFile("package-lock.json")).toBe("data");
    expect(classifyFile("src/app.ts")).toBe("code");
    expect(classifyFile("tsconfig.json")).toBe("config");
    expect(classifyFile("README.md")).toBe("doc");
    // Unknown extensions fall back to config — the option that reads the
    // file as text and gives up quietly — rather than being mislabelled as
    // `code` and emitting nonsense signatures.
    expect(classifyFile("data.unknownext")).toBe("config");
  });
});

describe("buildCodebaseMap", () => {
  it("renders the asset variant as a bare path with no line count", async () => {
    await fs.writeFile(path.join(root, "logo.png"), "not really a png");
    const map = await buildCodebaseMap(root, ["logo.png"]);

    // The asset variant carries only a path. A `[asset]` header plus the
    // absence of a line count is the observable proof that `skeletonFor`
    // returned the narrow variant and never opened the file for reading —
    // opening a binary as UTF-8 would be slow and would produce a garbage
    // line count.
    expect(map.text).toContain("logo.png  [asset]");
    expect(map.text).not.toMatch(/logo\.png.*lines/);
  });

  it("renders the code variant with a line count, deps, and signatures", async () => {
    await fs.writeFile(
      path.join(root, "app.ts"),
      [
        "import { helper } from './helper'",
        "import fs from 'node:fs'",
        "",
        "export function greet(name: string): string {",
        "  return `hi ${name}`",
        "}",
      ].join("\n"),
    );
    const map = await buildCodebaseMap(root, ["app.ts"]);

    // The code variant is the only one with the `[code, N lines]` header.
    expect(map.text).toMatch(/app\.ts {2}\[code, \d+ lines\]/);
    // Imports are collected into the `deps:` line, in source order.
    expect(map.text).toContain("deps: ./helper, node:fs");
    // The exported function's signature is collapsed onto one line, up to
    // but not including the opening brace.
    expect(map.text).toContain("export function greet(name: string): string");
    // The config-family's preview separator must not appear on a code file:
    // that marker is what distinguishes the two body shapes.
    expect(map.text).not.toContain("  ---");
  });

  it("renders a code file with no exports as a stable placeholder", async () => {
    await fs.writeFile(path.join(root, "internal.ts"), "const x = 1\n");
    const map = await buildCodebaseMap(root, ["internal.ts"]);

    // The exhaustive switch on `kind: 'code'` falls through to the
    // placeholder rather than emitting a blank section that would read as a
    // truncated map in the prompt.
    expect(map.text).toContain("(no exported symbols detected)");
  });

  it("renders the config variant with the preview separator and body", async () => {
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
    );
    const map = await buildCodebaseMap(root, ["tsconfig.json"]);

    // The tag carries the actual kind (`config`), not a generic "data".
    expect(map.text).toMatch(/tsconfig\.json {2}\[config, \d+ lines\]/);
    // The `---` line is the config-family-only separator between the header
    // and the preview body.
    expect(map.text).toContain("  ---");
    // The preview body is the file's leading lines, indented under the
    // separator.
    expect(map.text).toContain('"compilerOptions"');
  });

  it("renders doc and config variants through the same layout, differing only by tag", async () => {
    await fs.writeFile(path.join(root, "README.md"), "# Title\n\nBody.\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.0" }),
    );
    const map = await buildCodebaseMap(root, ["README.md", "package.json"]);

    // Both files share the config-family body shape; only the header tag
    // distinguishes them.
    expect(map.text).toMatch(/README\.md {2}\[doc, \d+ lines\]/);
    expect(map.text).toMatch(/package\.json {2}\[config, \d+ lines\]/);
    // One separator per file, exactly. Two sections → two `  ---` lines.
    expect(map.text.match(/ {2}---/g)?.length).toBe(2);
  });

  it("orders sections by path and reports the contributing file count", async () => {
    await fs.writeFile(path.join(root, "b.ts"), "export const b = 1\n");
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1\n");
    await fs.writeFile(path.join(root, "c.png"), "x");

    // Requested out of order to prove the sort is applied by the builder,
    // not inherited from the caller.
    const map = await buildCodebaseMap(root, ["b.ts", "c.png", "a.ts"]);
    const sections = map.text.split("\n\n").map((section) => section.split(" ")[0]);
    expect(sections).toEqual(["a.ts", "b.ts", "c.png"]);
    expect(map.fileCount).toBe(3);
  });
});