/**
 * Parses the session protocol sections out of a pasted response:
 *
 *   ===Plan===      replacement checklist
 *   ===Need===      paths the model wants to see before editing
 *
 * and wraps the existing three-section parser. Both new sections are optional
 * and both accept the legacy heading dialect (`## Plan`, `## Need`) so a model
 * that drifts into markdown still works.
 *
 * Why this exists: a web chat cannot read the filesystem, so the only way it
 * can obtain context it was not given is to ask for it. `===Need===` is that
 * ask. It is the difference between a one-shot rewrite and a loop.
 */
import { parseResponse } from "../coding/response-parser";
import type { PlanStep, SessionParseResult } from "@shared/types";
import { normalizePath } from "../coding/response-parser/path-heuristics";

const SECTION_CLOSE = /^[ \t]*={6}[ \t]*(?:\r?\n|$)/m;

function delimitedOpen(name: string): RegExp {
  return new RegExp(`^[ \\t]*={2,}\\s*${name}\\s*={2,}[ \\t]*(?:\\r?\\n|$)`, "im");
}

function headingOpen(name: string): RegExp {
  return new RegExp(`^[ \\t]*#{1,6}[^\\r\\n]*\\b${name}\\b[^\\r\\n]*(?:\\r?\\n|$)`, "im");
}

/**
 * Body of a named section. `undefined` means the section is absent; an empty
 * string means it is present but blank. That distinction matters: an absent
 * `===Plan===` means "unchanged", a present-but-empty one means "clear it".
 */
export function sectionBody(raw: string, name: string): string | undefined {
  const delimited = delimitedOpen(name);
  const open = delimited.exec(raw) ?? headingOpen(name).exec(raw);
  if (open === null) return undefined;

  const rest = raw.slice(open.index + open[0].length);

  // Delimited form: body ends at the next `======` terminator or the next
  // `===<Name>===` opener, whichever comes first.
  const close = SECTION_CLOSE.exec(rest);
  const nextSection = /^[ \t]*={2,}\s*[A-Za-z][A-Za-z ]*\s*={2,}[ \t]*(?:\r?\n|$)/m.exec(rest);
  const nextHeading = /^[ \t]*#{1,6}\s+\S/m.exec(rest);

  const candidates = [close?.index, nextSection?.index, nextHeading?.index]
    .filter((index): index is number => typeof index === "number" && index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;

  return rest.slice(0, end);
}

const NONE_WORDS = new Set(["none", "n/a", "nothing", "no", "nope", "-"]);

/**
 * Parse the `===Need===` section into project-relative paths.
 *
 * Accepts one path per line, with or without a leading dash/bullet, and
 * ignores prose lines, `None`, and anything that `normalizePath` rejects.
 */
export function parseNeeds(raw: string): string[] {
  const body = sectionBody(raw, "Need");
  if (body === undefined) return [];

  const needs: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^`|`$/g, "")
      .trim();
    if (line === "") continue;
    if (NONE_WORDS.has(line.toLowerCase())) continue;
    // A line with spaces and no extension is prose, not a path.
    if (!/[./]/.test(line)) continue;
    const normalized = normalizePath(line);
    if (normalized === null) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    needs.push(normalized);
  }
  return needs;
}

const PLAN_LINE = /^[ \t]*[-*+]?\s*\[( |x|X|>|!)\]\s*(.+?)\s*$/;

/**
 * Parse the `===Plan===` section into steps.
 *
 * Checkbox syntax: `[ ]` pending, `[x]` done, `[>]` active, `[!]` blocked.
 * Bare `1. text` lines are accepted as pending steps so a model that writes a
 * numbered list instead of checkboxes still produces a usable plan.
 */
export function parsePlan(raw: string): PlanStep[] | null {
  const body = sectionBody(raw, "Plan");
  if (body === undefined) return null;

  const trimmed = body.trim();
  if (trimmed === "" || NONE_WORDS.has(trimmed.toLowerCase())) return null;

  const steps: PlanStep[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = PLAN_LINE.exec(line);
    if (match) {
      const marker = match[1];
      const text = (match[2] ?? "").trim();
      if (text === "") continue;
      const status =
        marker === "x" || marker === "X"
          ? "done"
          : marker === ">"
            ? "active"
            : marker === "!"
              ? "blocked"
              : "pending";
      steps.push({ id: `step-${steps.length + 1}`, text, status });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    if (numbered) {
      const text = (numbered[1] ?? "").trim();
      if (text !== "") {
        steps.push({ id: `step-${steps.length + 1}`, text, status: "pending" });
      }
    }
  }

  return steps.length > 0 ? steps : null;
}

/**
 * Full session parse: the base three-section result plus the session sections.
 */
export function parseSessionResponse(raw: string): SessionParseResult {
  const base = parseResponse(raw);
  return {
    ...base,
    needs: parseNeeds(raw),
    plan: parsePlan(raw),
  };
}
