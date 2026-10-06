export type GitFileStatusCode =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflicted";

export interface GitFileChange {
  /** POSIX-relative path of the current name. */
  path: string;
  status: GitFileStatusCode;
  /** Previous path for renames and copies; undefined otherwise. */
  oldPath?: string;
}

/**
 * Snapshot of `git status` at a moment in time. `null` from the status call
 * means the folder is not a Git repository.
 */
export interface GitStatus {
  /** Current branch name, or `null` when HEAD is detached or unborn. */
  branch: string | null;
  /** Number of commits ahead of upstream. */
  ahead: number;
  /** Number of commits behind upstream. */
  behind: number;
  /** Files with staged changes (index differs from HEAD). */
  staged: GitFileChange[];
  /** Files with unstaged changes (working tree differs from index). */
  unstaged: GitFileChange[];
  /** Untracked files (present in working tree, not in index). */
  untracked: string[];
  /** Files with merge conflicts. */
  conflicted: GitFileChange[];
}

export interface GitInitRequest {
  projectRoot: string;
}

export interface GitInitResult {
  /** True when `.git` was created by this call; false when it already existed. */
  created: boolean;
}

export interface GitStageRequest {
  projectRoot: string;
  path: string;
}

export interface GitUnstageRequest {
  projectRoot: string;
  path: string;
}

export interface GitDiscardRequest {
  projectRoot: string;
  path: string;
  /**
   * When true the file is untracked and the caller wants it removed from
   * disk entirely rather than restored from Git.
   */
  untracked: boolean;
}

export interface GitCommitRequest {
  projectRoot: string;
  message: string;
}

export interface GitCommitResult {
  /** Full 40-character hash of the new commit. Empty when it could not be read. */
  commitHash: string;
  /** Raw stdout from `git commit`, useful for the notice banner. */
  summary: string;
}

export interface GitDiffRequest {
  projectRoot: string;
  path: string;
  /**
   * `true` for a staged diff (index vs HEAD), `false` for an unstaged diff
   * (working tree vs index).
   */
  staged: boolean;
}

export interface GitDiffContent {
  /** Content of the left side of the diff. */
  original: string;
  /** Content of the right side of the diff. */
  modified: string;
  /**
   * Whether either side had content.
   */
  exists: boolean;
}
