export interface FileNode {
  id: string;
  name: string;
  /** POSIX-style path relative to the project root. */
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  selected: boolean;
  expanded: boolean;
  /** Byte size for files; undefined for directories. */
  size?: number;
  /**
   * True when the file's name matches a pattern for files that routinely
   * carry secrets (`.env`, `id_rsa`, `*.pem`, `credentials.json`, …). The
   * tree renders these with a warning indicator and the prompt build reports
   * them, so the user always knows what is about to be pasted into a chat.
   */
  sensitive?: boolean;
}

export interface ScanResult {
  root: string;
  tree: FileNode;
  /** Number of files that passed the gitignore/binary filters. */
  fileCount: number;
  /** Number of entries dropped by .gitignore or the always-skip list. */
  skippedCount: number;
}

export type PathSource =
  | "file-header"
  | "first-line-comment"
  | "preceding-text"
  | "language-hint"
  | "delete-header"
  | "user";

export interface DeleteFileRequest {
  projectRoot: string;
  path: string;
}

export interface DeleteFileResult {
  /** `not-found` when the file did not exist on disk. */
  status: "deleted" | "not-found";
}

export interface WriteFileRequest {
  projectRoot: string;
  path: string;
  content: string;
}

export interface WriteFileResult {
  status: "created" | "overwritten" | "skipped";
}

/**
 * Input for the native confirmation dialog. Replaces `window.confirm` in the
 * renderer. Electron's synchronous `window.confirm` blocks the renderer
 * process while the dialog is open and — on some platforms — leaves keyboard
 * focus in a broken state after the dialog closes.
 */
export interface ConfirmDialogRequest {
  /** Primary question, rendered as the dialog's bold headline. */
  message: string;
  /** Optional secondary paragraph for consequences or extra context. */
  detail?: string;
  /** Label on the affirmative button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label on the negative button. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Visual severity, which selects the dialog's icon.
   */
  tone?: "info" | "question" | "warning" | "danger";
}
