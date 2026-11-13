import type {
  ApplyRequest,
  ApplyResult,
  DiffResult,
  PatchBlock,
} from "@shared/types";
import {
  deleteFile,
  fileExists,
  readTextFile,
  resolveWithinRoot,
  writeFile,
} from "../core/fs-service";

/**
 * Read the on-disk and proposed versions of a file so the UI can render a diff.
 * A file that does not exist yet comes back with an empty original.
 */
export async function computeDiff(
  projectRoot: string,
  relativePath: string,
  proposed: string,
): Promise<DiffResult> {
  resolveWithinRoot(projectRoot, relativePath);
  const exists = await fileExists(projectRoot, relativePath);
  const original = exists ? await readTextFile(projectRoot, relativePath) : "";
  return { original, modified: proposed, exists };
}

/**
 * Write the confirmed files. Every path is re-validated here even though the
 * renderer already checked it — the renderer is not a trust boundary.
 *
 * A failure on one file never rolls back the others; each result is reported
 * and the user decides what to do next.
 *
 * Three shapes are supported, mirroring the parser:
 *   - Full content: `content` is written as-is (new file or full rewrite).
 *   - Patches: `patches` are applied in order to the file on disk, then the
 *     result is written. Any patch that cannot be located fails the whole
 *     file — the applier never writes a partial or guessed result.
 *   - Delete: `delete` is true. The file is removed; a missing file is a
 *     no-op reported as `deleted` (the desired end state already holds),
 *     not an error.
 *
 * Version history is provided by Git source control, not by `.bak` siblings
 * — a write or delete that lands here is picked up by the next status
 * refresh and is undone from the Source Control panel.
 */
export async function applyFiles(
  request: ApplyRequest,
): Promise<ApplyResult[]> {
  if (request.atomic === true) return applyAtomically(request);

  const results: ApplyResult[] = [];

  for (const file of request.files) {
    if (file.path === null || file.path === "") {
      results.push({
        path: file.path ?? "",
        status: "failed",
        error: "No target path.",
      });
      continue;
    }
    try {
      if (file.delete === true) {
        await deleteFile(request.projectRoot, file.path);
        results.push({ path: file.path, status: "deleted" });
      } else if (file.patches && file.patches.length > 0) {
        await writePatchedFile(
          request.projectRoot,
          file.path,
          file.patches,
        );
        results.push({ path: file.path, status: "patched" });
      } else {
        const collapse = await detectSizeCollapse(
          request.projectRoot,
          file.path,
          file.content,
        );
        if (collapse) {
          results.push({
            path: file.path,
            status: "failed",
            error: collapse,
          });
          continue;
        }
        const outcome = await writeFile(
          request.projectRoot,
          file.path,
          file.content,
        );
        results.push({ path: file.path, status: outcome.status });
      }
    } catch (error) {
      results.push({
        path: file.path,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * All-or-nothing apply.
 *
 * Phase 1 resolves every entry without touching the disk: paths are validated,
 * patches are applied in memory against the current file contents, and the
 * size-collapse guard runs. Only if every entry resolves is anything written.
 *
 * A mid-batch failure therefore leaves the tree byte-identical, which is what
 * the session loop needs: a partially applied turn is a state neither the
 * model nor the verifier can reason about.
 */
async function applyAtomically(request: ApplyRequest): Promise<ApplyResult[]> {
  interface Planned {
    path: string;
    kind: "write" | "delete" | "patch";
    content: string;
    exists: boolean;
  }

  const planned: Planned[] = [];
  const failures: ApplyResult[] = [];

  for (const file of request.files) {
    if (file.path === null || file.path === "") {
      failures.push({ path: file.path ?? "", status: "failed", error: "No target path." });
      continue;
    }
    try {
      resolveWithinRoot(request.projectRoot, file.path);
      const exists = await fileExists(request.projectRoot, file.path);

      if (file.delete === true) {
        planned.push({ path: file.path, kind: "delete", content: "", exists });
        continue;
      }

      if (file.patches && file.patches.length > 0) {
        if (!exists) {
          throw new Error(
            `${file.path} does not exist on disk, so a patch cannot be applied. Ask the AI to emit the full file instead.`,
          );
        }
        const original = await readTextFile(request.projectRoot, file.path);
        const applied = applyPatches(original, file.patches);
        if (!applied.ok) {
          throw new Error(`${applied.reason} Ask the AI to resend this file as a full rewrite.`);
        }
        planned.push({ path: file.path, kind: "patch", content: applied.content, exists });
        continue;
      }

      const collapse = await detectSizeCollapse(request.projectRoot, file.path, file.content);
      if (collapse !== null) throw new Error(collapse);

      planned.push({ path: file.path, kind: "write", content: file.content, exists });
    } catch (error) {
      failures.push({
        path: file.path,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    // Nothing has been written. Report the blocked entries and mark the rest
    // as skipped so the caller can tell "failed" from "never attempted".
    const failedPaths = new Set(failures.map((result) => result.path));
    return [
      ...failures,
      ...request.files
        .filter((file) => file.path !== null && !failedPaths.has(file.path ?? ""))
        .map((file) => ({
          path: file.path as string,
          status: "skipped" as const,
          error: "Not applied: another entry in this batch failed.",
        })),
    ];
  }

  // Phase 2: write. A write error here is a real I/O failure, which is rare
  // enough that the honest response is to report exactly which entries landed.
  const results: ApplyResult[] = [];
  for (const entry of planned) {
    try {
      if (entry.kind === "delete") {
        await deleteFile(request.projectRoot, entry.path);
        results.push({ path: entry.path, status: "deleted" });
        continue;
      }
      if (entry.kind === "patch") {
        await writeFile(request.projectRoot, entry.path, entry.content);
        results.push({ path: entry.path, status: "patched" });
        continue;
      }
      const outcome = await writeFile(request.projectRoot, entry.path, entry.content);
      results.push({ path: entry.path, status: outcome.status });
    } catch (error) {
      results.push({
        path: entry.path,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * A full-file rewrite that is dramatically smaller than the file it replaces
 * is almost always a truncated response, not an intentional deletion of most
 * of the file. Writing it would silently destroy code the model never meant
 * to remove, so the write is refused and the result explains what to ask for.
 *
 * Thresholds: below `MIN_LINES_FOR_COLLAPSE_CHECK` a file is small enough that
 * a real rewrite can legitimately shrink it a lot. Above that, keeping less
 * than `MIN_RETAINED_FRACTION` of the original lines means something went
 * wrong upstream.
 */
const MIN_LINES_FOR_COLLAPSE_CHECK = 40;
const MIN_RETAINED_FRACTION = 0.4;

async function detectSizeCollapse(
  root: string,
  relativePath: string,
  proposed: string,
): Promise<string | null> {
  if (!(await fileExists(root, relativePath))) return null;
  const original = await readTextFile(root, relativePath);

  const originalLines = original.split("\n").length;
  const proposedLines = proposed.split("\n").length;
  if (originalLines < MIN_LINES_FOR_COLLAPSE_CHECK) return null;

  const retained = proposedLines / originalLines;
  if (retained >= MIN_RETAINED_FRACTION) return null;

  return (
    `Refused to write ${relativePath}: the response contains ${proposedLines} lines ` +
    `but the file on disk has ${originalLines} (${Math.round(retained * 100)}% retained). ` +
    `This usually means the answer was cut off. Ask the AI to resend the complete file, ` +
    `or use a patch for a targeted change.`
  );
}

/**
 * Apply a list of SEARCH/REPLACE patches to the file on disk and write the
 * result. The file must already exist — a patch that targets a missing file
 * is a prompt-contract violation (the model should have emitted the whole
 * file) and is reported rather than silently creating the file.
 */
async function writePatchedFile(
  root: string,
  relativePath: string,
  patches: PatchBlock[],
): Promise<void> {
  if (!(await fileExists(root, relativePath))) {
    throw new Error(
      `${relativePath} does not exist on disk, so a patch cannot be applied. Ask the AI to emit the full file instead.`,
    );
  }
  const original = await readTextFile(root, relativePath);
  const applied = applyPatches(original, patches);
  if (!applied.ok) {
    throw new Error(
      `${applied.reason} Ask the AI to resend this file as a full rewrite.`,
    );
  }
  await writeFile(root, relativePath, applied.content);
}

export type PatchOutcome =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Apply SEARCH/REPLACE pairs to `original` in order. Each pair is matched as
 * an exact substring first; if that fails, a whitespace-tolerant pass strips
 * trailing spaces per line on both sides before comparing, which handles the
 * most common drift a model introduces. A pair that matches neither way is
 * rejected — applying the wrong edit silently is worse than refusing.
 */
export function applyPatches(
  original: string,
  patches: PatchBlock[],
): PatchOutcome {
  let working = original;
  for (let i = 0; i < patches.length; i += 1) {
    const patch = patches[i];
    if (!patch) {
      return {
        ok: false,
        reason: `Internal error: patch ${i + 1} is missing.`,
      };
    }

    const exact = working.indexOf(patch.search);
    if (exact !== -1) {
      working =
        working.slice(0, exact) +
        patch.replace +
        working.slice(exact + patch.search.length);
      continue;
    }

    const fuzzy = findWhitespaceTolerant(working, patch.search);
    if (!fuzzy) {
      return {
        ok: false,
        reason: `SEARCH block ${i + 1} was not found in the file (tried exact and whitespace-normalized matches).`,
      };
    }
    working =
      working.slice(0, fuzzy.start) + patch.replace + working.slice(fuzzy.end);
  }
  return { ok: true, content: working };
}

interface LineSlice {
  start: number;
  /** Exclusive — includes the line terminator when one was present. */
  end: number;
  /** Line text without the terminator (and without a trailing `\r`). */
  content: string;
}

function sliceLines(text: string): LineSlice[] {
  const lines: LineSlice[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    const raw = text.slice(start, i);
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ start, end: i + 1, content });
    start = i + 1;
  }
  if (start < text.length) {
    lines.push({ start, end: text.length, content: text.slice(start) });
  }
  return lines;
}

/**
 * Locate `needle` inside `haystack` as a contiguous run of lines, ignoring
 * trailing whitespace on each line. Returns the byte range covering the
 * matched lines' content (not their terminators) so the replacement can be
 * spliced in without eating the newline that follows the last matched line.
 */
function findWhitespaceTolerant(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const hay = sliceLines(haystack);
  const want = needle.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ""));
  if (want.length === 0) return null;

  for (let start = 0; start + want.length <= hay.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < want.length; offset += 1) {
      const line = hay[start + offset];
      if (!line) {
        ok = false;
        break;
      }
      if (line.content.replace(/[ \t]+$/, "") !== want[offset]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const first = hay[start];
    const last = hay[start + want.length - 1];
    if (!first || !last) return null;
    return { start: first.start, end: last.start + last.content.length };
  }
  return null;
}
