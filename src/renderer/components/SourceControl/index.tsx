import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { GitFileChange } from "@shared/types";
import { useAppStore } from "../../stores/app-store";
import { Banner, Button } from "../../lib/ui";
import { GitDiffViewer } from "./GitDiffViewer";

/** Single-letter glyph shown for each status code, mirroring `git status`. */
const STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  conflicted: "U",
};

const STATUS_COLOR: Record<GitFileChange["status"], string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-red-400",
  renamed: "text-sky-400",
  copied: "text-sky-400",
  typechange: "text-amber-400",
  conflicted: "text-red-400",
};

interface DiffTarget {
  path: string;
  staged: boolean;
}

interface FileRowProps {
  path: string;
  status: GitFileChange["status"];
  oldPath?: string;
  primary: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  onDiff: () => void;
  disabled: boolean;
}

function FileRow({
  path,
  status,
  oldPath,
  primary,
  secondary,
  onDiff,
  disabled,
}: FileRowProps): ReactElement {
  return (
    <div
      className="group flex items-center gap-2 px-2 py-1 text-xs hover:bg-[#23262d]"
      title={oldPath ? `${oldPath} → ${path}` : path}
    >
      <span
        className={`w-3 shrink-0 font-mono font-bold ${STATUS_COLOR[status]}`}
      >
        {STATUS_LETTER[status]}
      </span>
      <button
        type="button"
        onClick={onDiff}
        className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-slate-100"
      >
        {path}
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {secondary ? (
          <Button
            variant="ghost"
            className="px-1.5 py-0.5 text-[10px]"
            disabled={disabled}
            onClick={secondary.onClick}
            title={secondary.label}
          >
            {secondary.label}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="px-1.5 py-0.5 text-[10px]"
          disabled={disabled}
          onClick={primary.onClick}
          title={primary.label}
        >
          {primary.label}
        </Button>
      </span>
    </div>
  );
}

interface SectionProps {
  title: string;
  count: number;
  children: ReactNode;
}

function Section({ title, count, children }: SectionProps): ReactElement {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        <span>{title}</span>
        <span className="rounded bg-[#2a2f38] px-1.5 text-slate-400">
          {count}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SourceControl(): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  const status = useAppStore((state) => state.gitStatus);
  const statusLoading = useAppStore((state) => state.gitStatusLoading);
  const busy = useAppStore((state) => state.gitBusy);
  const commitMessage = useAppStore((state) => state.gitCommitMessage);
  const setCommitMessage = useAppStore((state) => state.setGitCommitMessage);
  const refresh = useAppStore((state) => state.refreshGitStatus);
  const init = useAppStore((state) => state.initGitRepo);
  const stage = useAppStore((state) => state.stageGitPath);
  const stageAll = useAppStore((state) => state.stageAllGitPaths);
  const unstage = useAppStore((state) => state.unstageGitPath);
  const discard = useAppStore((state) => state.discardGitPath);
  const discardAll = useAppStore((state) => state.discardAllGitPaths);
  const commit = useAppStore((state) => state.commitGitChanges);

  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);

  // Refresh when the tab mounts against a different project root. The store
  // already refreshes on project open, so this is mostly a safety net for
  // HMR and remounts.
  useEffect(() => {
    if (projectRoot) void refresh();
  }, [projectRoot, refresh]);

  if (!projectRoot) {
    return (
      <div className="min-h-0 flex-1 p-3 text-xs text-slate-500">
        Open a folder to see source control.
      </div>
    );
  }

  if (status === undefined) {
    return (
      <div className="min-h-0 flex-1 p-3 text-xs text-slate-500">
        Loading Git status…
      </div>
    );
  }

  if (status === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-3">
        <Banner tone="info">
          This folder is not a Git repository. Initialize one to track
          changes, stage files, and commit.
        </Banner>
        <Button variant="primary" disabled={busy} onClick={() => void init()}>
          {busy ? "Initializing…" : "Initialize Git Repository"}
        </Button>
      </div>
    );
  }

  const hasStaged = status.staged.length > 0;
  const canCommit = hasStaged && commitMessage.trim() !== "" && !busy;
  const hasAnyChange =
    status.staged.length +
      status.unstaged.length +
      status.untracked.length +
      status.conflicted.length >
    0;
  const hasDiscardable = status.unstaged.length > 0;

  return (
    // `min-h-0 flex-1` rather than `h-full`: the parent is a `flex-col`
    // whose other child (the tab bar) is `shrink-0`, so this element must
    // grow to fill the remaining vertical space. `height: 100%` on a flex
    // item resolves against the parent's computed height, which is not yet
    // established on the first paint — the result is a zero-height panel
    // that renders as a blank tab.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#2c3038] px-2 py-1.5 text-xs">
        <span className="font-mono text-slate-300">
          {status.branch ?? "(detached)"}
        </span>
        {status.ahead > 0 ? (
          <span
            className="text-slate-500"
            title={`${status.ahead} commit(s) ahead of upstream`}
          >
            ↑{status.ahead}
          </span>
        ) : null}
        {status.behind > 0 ? (
          <span
            className="text-slate-500"
            title={`${status.behind} commit(s) behind upstream`}
          >
            ↓{status.behind}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            disabled={busy || statusLoading || !hasAnyChange}
            onClick={() => void stageAll()}
            title="Stage every change (modified, added, deleted, untracked)"
          >
            Stage all
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            disabled={busy || statusLoading || !hasDiscardable}
            onClick={() => void discardAll()}
            title={
              hasDiscardable
                ? "Discard every unstaged change to tracked files"
                : "No unstaged changes to discard"
            }
          >
            Discard all
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            disabled={statusLoading || busy}
            onClick={() => void refresh()}
            title="Refresh Git status"
          >
            {statusLoading ? "…" : "↻"}
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-b border-[#2c3038] p-2">
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Commit message"
          rows={2}
          spellCheck={false}
          className="w-full resize-y rounded border border-[#2c3038] bg-[#12141a] p-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
        />
        <div className="mt-1.5 flex justify-end">
          <Button
            variant="primary"
            className="px-2 py-0.5 text-xs"
            disabled={!canCommit}
            onClick={() => void commit()}
            title={
              !hasStaged
                ? "Stage some changes first"
                : commitMessage.trim() === ""
                  ? "Enter a commit message"
                  : "Commit the staged changes"
            }
          >
            {busy
              ? "Working…"
              : `Commit${hasStaged ? ` ${status.staged.length}` : ""}`}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-2">
        {status.conflicted.length > 0 ? (
          <Section title="Conflicts" count={status.conflicted.length}>
            {status.conflicted.map((change) => (
              <FileRow
                key={`conflict:${change.path}`}
                path={change.path}
                status={change.status}
                oldPath={change.oldPath}
                primary={{
                  label: "Mark resolved",
                  onClick: () => void stage(change.path),
                }}
                onDiff={() =>
                  setDiffTarget({ path: change.path, staged: false })
                }
                disabled={busy}
              />
            ))}
          </Section>
        ) : null}

        {status.staged.length > 0 ? (
          <Section title="Staged Changes" count={status.staged.length}>
            {status.staged.map((change) => (
              <FileRow
                key={`staged:${change.path}`}
                path={change.path}
                status={change.status}
                oldPath={change.oldPath}
                primary={{
                  label: "−",
                  onClick: () => void unstage(change.path),
                }}
                onDiff={() =>
                  setDiffTarget({ path: change.path, staged: true })
                }
                disabled={busy}
              />
            ))}
          </Section>
        ) : null}

        {status.unstaged.length > 0 ? (
          <Section title="Changes" count={status.unstaged.length}>
            {status.unstaged.map((change) => (
              <FileRow
                key={`unstaged:${change.path}`}
                path={change.path}
                status={change.status}
                oldPath={change.oldPath}
                primary={{
                  label: "+",
                  onClick: () => void stage(change.path),
                }}
                secondary={{
                  label: "Discard",
                  onClick: () => void discard(change.path, false),
                }}
                onDiff={() =>
                  setDiffTarget({ path: change.path, staged: false })
                }
                disabled={busy}
              />
            ))}
          </Section>
        ) : null}

        {status.untracked.length > 0 ? (
          <Section title="Untracked Files" count={status.untracked.length}>
            {status.untracked.map((path) => (
              <FileRow
                key={`untracked:${path}`}
                path={path}
                status="added"
                primary={{
                  label: "+",
                  onClick: () => void stage(path),
                }}
                secondary={{
                  label: "Delete",
                  onClick: () => void discard(path, true),
                }}
                onDiff={() => setDiffTarget({ path, staged: false })}
                disabled={busy}
              />
            ))}
          </Section>
        ) : null}

        {status.staged.length === 0 &&
        status.unstaged.length === 0 &&
        status.untracked.length === 0 &&
        status.conflicted.length === 0 ? (
          <p className="p-3 text-xs text-slate-500">
            No changes. The working tree matches the last commit.
          </p>
        ) : null}
      </div>

      {diffTarget ? (
        <GitDiffViewer
          path={diffTarget.path}
          staged={diffTarget.staged}
          onClose={() => setDiffTarget(null)}
        />
      ) : null}
    </div>
  );
}