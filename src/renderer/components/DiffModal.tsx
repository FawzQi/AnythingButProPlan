import { useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { Banner, Button } from "../lib/ui";

/**
 * Shared shell for the two diff modals in the app: the coding-mode
 * `DiffViewer` (on-disk vs proposed) and the Source Control
 * `GitDiffViewer` (Git ref vs Git ref). The two callers differ only in
 * where the two sides come from and what the column titles say; the
 * layout, loading branch, error branch, ReactDiffViewer options, and
 * Escape-to-close effect are identical and live here.
 */
export interface DiffModalProps {
  path: string;
  /** Optional small subtitle shown under the path (e.g. the Git ref pair). */
  subtitle?: string;
  /**
   * Left side. `null` means "still loading" and renders the loading text.
   * The empty string is a legitimate value and renders the empty-banner
   * variant when `emptyMessage` is set.
   */
  left: string | null;
  right: string;
  leftTitle: string;
  rightTitle: string;
  error: string | null;
  /**
   * Optional content to render instead of the diff when both sides are
   * empty. Only the Git viewer uses this — a both-empty pair there means
   * the file was absent from both refs, which is worth a banner rather
   * than a blank diff.
   */
  emptyMessage?: ReactNode;
  onClose: () => void;
}

export function DiffModal({
  path,
  subtitle,
  left,
  right,
  leftTitle,
  rightTitle,
  error,
  emptyMessage,
  onClose,
}: DiffModalProps): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const bothEmpty = left === "" && right === "";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#2c3038] bg-[#16181d]">
        <header className="flex shrink-0 items-center justify-between border-b border-[#2c3038] px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm text-slate-200">
              {path}
            </h2>
            {subtitle ? (
              <p className="text-[10px] uppercase tracking-wide text-slate-500">
                {subtitle}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="p-3">
              <Banner tone="error">{error}</Banner>
            </div>
          ) : left === null ? (
            <p className="p-3 text-xs text-slate-500">Loading…</p>
          ) : bothEmpty && emptyMessage ? (
            <div className="p-3">{emptyMessage}</div>
          ) : (
            <ReactDiffViewer
              oldValue={left}
              newValue={right}
              splitView
              useDarkTheme
              // Same as the pre-extraction viewers: show the whole file on
              // both sides so surrounding context is visible, rather than
              // collapsing everything outside the changed hunks.
              showDiffOnly={false}
              leftTitle={leftTitle}
              rightTitle={rightTitle}
            />
          )}
        </div>
      </div>
    </div>
  );
}