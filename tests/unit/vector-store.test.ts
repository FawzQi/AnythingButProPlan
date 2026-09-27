import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk } from "../../src/main/services/chunker";
import { VectorStore } from "../../src/main/services/vector-store";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "abpp-index-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function chunk(document: string, index: number, text: string): Chunk {
  return { id: `${document}#${index}`, document, headingPath: "", index, text, tokens: 1 };
}

describe("VectorStore", () => {
  it("returns the nearest chunk first", () => {
    const store = new VectorStore();
    store.add([chunk("a.pdf", 0, "x"), chunk("b.pdf", 0, "y")], [
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const hits = store.query([0.9, 0.1, 0], 2);
    expect(hits[0]?.chunk.document).toBe("a.pdf");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("is scale-invariant — a longer vector with the same direction scores the same", () => {
    const store = new VectorStore();
    store.add([chunk("a.pdf", 0, "x")], [[1, 1]]);
    expect(store.query([100, 100], 1)[0]?.score).toBeCloseTo(1, 5);
  });

  it("rejects a vector whose width disagrees with the index", () => {
    const store = new VectorStore();
    store.add([chunk("a.pdf", 0, "x")], [[1, 0, 0]]);
    expect(() => store.add([chunk("b.pdf", 0, "y")], [[1, 0]])).toThrow(
      /dimensions/,
    );
  });

  it("removes every chunk of one document and leaves the rest", () => {
    const store = new VectorStore();
    store.add(
      [chunk("a.pdf", 0, "x"), chunk("a.pdf", 1, "y"), chunk("b.pdf", 0, "z")],
      [
        [1, 0],
        [1, 0],
        [0, 1],
      ],
    );
    expect(store.remove("a.pdf")).toBe(2);
    expect(store.documents()).toEqual(["b.pdf"]);
    expect(store.size).toBe(1);
  });

  it("round-trips through disk with vectors aligned to chunks", async () => {
    const store = new VectorStore();
    store.add([chunk("a.pdf", 0, "first"), chunk("a.pdf", 1, "second")], [
      [1, 0],
      [0, 1],
    ]);
    await store.persist(dir, "test-model");

    const reloaded = new VectorStore();
    expect(await reloaded.load(dir)).toBe(true);
    expect(reloaded.size).toBe(2);
    // The alignment is the contract: a query that matched chunk 1 before the
    // round trip must match it after.
    expect(reloaded.query([0, 1], 1)[0]?.chunk.text).toBe("second");
  });

  it("reports an empty directory as 'nothing to load', not as an error", async () => {
    const store = new VectorStore();
    expect(await store.load(dir)).toBe(false);
  });

  it("throws on a byte-length mismatch instead of misaligning chunks", async () => {
    const store = new VectorStore();
    store.add([chunk("a.pdf", 0, "one"), chunk("a.pdf", 1, "two")], [
      [1, 0],
      [0, 1],
    ]);
    await store.persist(dir, "test-model");
    // Truncate the vectors: a silent load here would pair chunk 1 with
    // chunk 0's vector and retrieve the wrong passage forever.
    await fs.writeFile(path.join(dir, "embeddings.bin"), Buffer.alloc(4));

    const reloaded = new VectorStore();
    await expect(reloaded.load(dir)).rejects.toThrow(/inconsistent/i);
  });
});
