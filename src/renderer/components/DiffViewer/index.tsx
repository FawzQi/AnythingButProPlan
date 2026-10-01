import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useAppStore } from "../../stores/app-store";
import { DiffModal } from "../DiffModal";

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

  return (
    <DiffModal
      path={path}
      left={original}
      right={content}
      leftTitle="On disk"
      rightTitle="Proposed"
      error={error}
      onClose={onClose}
    />
  );
}