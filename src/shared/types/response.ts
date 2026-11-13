import type { PathSource } from "./file";

/**
 * One SEARCH/REPLACE pair.
 */
export interface PatchBlock {
  search: string;
  replace: string;
}

/**
 * Fields shared by every parsed-file variant.
 */
interface ParsedFileCommon {
  /** Original text the AI wrote for this entry. Kept for the diff view. */
  rawBlock: string;
  language: string | null;
  pathSource: PathSource;
  content: string;
  /**
   * The code fence enclosing this entry was never closed, which means the
   * response was cut off. The content is shown but must not be written
   * without the user's explicit say-so.
   */
  truncated?: boolean;
}

/**
 * One entry from the AI response, discriminated on how it should be applied.
 */
export type ParsedFile =
  | (ParsedFileCommon & { kind: "full"; path: string })
  | (ParsedFileCommon & { kind: "unresolved"; path: null })
  | (ParsedFileCommon & { kind: "patch"; path: string; patches: PatchBlock[] })
  | (ParsedFileCommon & {
      kind: "delete";
      path: string;
      pathSource: "delete-header";
    });

export type ParseStrategy =
  | "markdown"
  | "patch"
  | "plaintext"
  | "delete"
  | "user-assisted";

export interface ParseResult {
  files: ParsedFile[];
  strategy: ParseStrategy;
  warnings: string[];
  debugCommands: string[];
}

export interface ApplyFileInput {
  path: string;
  /** Ignored when `patches` is present and non-empty, and when `delete` is set. */
  content: string;
  patches?: PatchBlock[];
  /**
   * When true, the applier deletes `path` instead of writing any content.
   */
  delete?: boolean;
}

export interface ApplyRequest {
  projectRoot: string;
  files: ApplyFileInput[];
  /**
   * All-or-nothing. Every entry is resolved against the disk first; if any
   * entry cannot be applied, nothing is written and every result explains the
   * blocker. Used by the session loop, where a half-applied batch would leave
   * the turn in a state neither the model nor the verifier understands.
   *
   * Defaults to false, which keeps the interactive panel's behaviour: each
   * file is attempted independently and reported on its own.
   */
  atomic?: boolean;
}

export interface ApplyResult {
  path: string;
  status:
    | "created"
    | "overwritten"
    | "patched"
    | "deleted"
    | "skipped"
    | "failed";
  error?: string;
}
