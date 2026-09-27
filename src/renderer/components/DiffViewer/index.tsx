import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { useAppStore } from "../../stores/app-store";
import { Banner, Button } from "../../lib/ui";

interface DiffViewerProps {
  path: string;
  content: string;
  onClose: () => void;
}

/** Side-by-side diff between what is on disk and what the AI proposed. */
export function DiffViewer({
  path,
  content,
  onClose,
}: DiffViewerProps): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  const [original, setOriginal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) return;
    window.AnythingButProPlan.diffFile({ projectRoot, path, content })
      .then((result) => {
        if (!cancelled) setOriginal(result.original);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, path, content]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#2c3038] bg-[#16181d]">
        <header className="flex shrink-0 items-center justify-between border-b border-[#2c3038] px-3 py-2">
          <h2 className="truncate font-mono text-sm text-slate-200">{path}</h2>
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
          ) : (
            <ReactDiffViewer
              oldValue={original}
              newValue={content}
              splitView
              useDarkTheme
              leftTitle="On disk"
              rightTitle="Proposed"
            />
          )}
        </div>
      </div>
    </div>
  );
}
