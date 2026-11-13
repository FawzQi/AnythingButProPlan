export interface PromptBuildRequest {
  projectRoot: string;
  /** POSIX-relative paths of the selected files. */
  files: string[];
  /**
   * Upper bound on the rendered prompt's token count. Files are taken in the
   * order given and any file that would push the prompt past the budget is
   * skipped and reported in `skippedByBudget` — never silently truncated,
   * because a half-file in context is worse than no file. Omitted means no
   * budget: every selected file goes in.
   */
  maxTokens?: number;
}

export interface PromptBuildResult {
  prompt: string;
  tokenCount: number;
  fileCount: number;
  /** Files that were selected but could not be read. */
  unreadable: string[];
  /**
   * Selected files whose names match a sensitive-file pattern.
   */
  sensitiveFiles: string[];
  /**
   * Files left out because including them would have exceeded `maxTokens`.
   * Empty when no budget was given or everything fit.
   */
  skippedByBudget: string[];
}

export interface DiffRequest {
  projectRoot: string;
  path: string;
  /** Proposed content; the existing content is read from disk. */
  content: string;
}

export interface DiffResult {
  original: string;
  modified: string;
  exists: boolean;
}
