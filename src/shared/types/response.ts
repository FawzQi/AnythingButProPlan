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
