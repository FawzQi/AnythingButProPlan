import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useAppStore } from "../../stores/app-store";
import { Banner } from "../../lib/ui";
import { DiffModal } from "../DiffModal";

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
 * unstaged diff shows index vs working tree. The layout is shared with
 * `DiffViewer` through `DiffModal`.
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

  const subtitle = staged
    ? "Staged diff (HEAD ↔ index)"
    : "Unstaged diff (index ↔ working tree)";

  return (
    <DiffModal
      path={path}
      subtitle={subtitle}
      left={original}
      right={modified}
      leftTitle={staged ? "HEAD" : "Staged"}
      rightTitle={staged ? "Staged" : "Working tree"}
      error={error}
      emptyMessage={
        <Banner tone="info">
          Both sides are empty — the file may have been deleted on both sides
          or never had content in the compared refs.
        </Banner>
      }
      onClose={onClose}
    />
  );
}