export interface PromptBuildRequest {
  projectRoot: string;
  /** POSIX-relative paths of the selected files. */
  files: string[];
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
