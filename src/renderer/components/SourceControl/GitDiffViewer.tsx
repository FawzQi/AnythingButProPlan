import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { useAppStore } from "../../stores/app-store";
import { Banner, Button } from "../../lib/ui";

interface GitDiffViewerProps {
  path: string;
  /**
   * `true` for a staged diff (index vs HEAD), `false` for a working-tree
   * diff (working tree vs index). The wording of the column titles and the
   * empty-state message both depend on it.
   */
  staged: boolean;
  onClose: () => void;
}

/**
 * Modal showing the two sides of a Git diff for a single file. Unlike the
 * plain `DiffViewer` (which reads the original from disk), this component
 * pulls both sides from Git so a staged diff shows HEAD vs index and an
 * unstaged diff shows index vs working tree.
 */
export function GitDiffViewer({
  path,
  staged,
  onClose,
}: GitDiffViewerProps): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) return;
    window.AnythingButProPlan.gitDiff({ projectRoot, path, staged })
      .then((result) => {
        if (cancelled) return;
        setOriginal(result.original);
        setModified(result.modified);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, path, staged]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const leftTitle = staged ? "HEAD" : "Staged";
  const rightTitle = staged ? "Staged" : "Working tree";

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
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {staged
                ? "Staged diff (HEAD ↔ index)"
                : "Unstaged diff (index ↔ working tree)"}
            </p>
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
          ) : original === null ? (
            <p className="p-3 text-xs text-slate-500">Loading…</p>
          ) : original === "" && modified === "" ? (
            <div className="p-3">
              <Banner tone="info">
                Both sides are empty — the file may have been deleted on both
                sides or never had content in the compared refs.
              </Banner>
            </div>
          ) : (
            <ReactDiffViewer
              oldValue={original}
              newValue={modified}
              splitView
              useDarkTheme
              // Same as the plain DiffViewer: show the whole file on both
              // sides so the surrounding context is visible, rather than
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
