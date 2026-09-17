import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ParseResult } from "@shared/types";
import { useAppStore, parsedFileKey } from "../../stores/app-store";
import { useDebouncedEffect } from "../../lib/hooks";
import { Banner, Button, Panel } from "../../lib/ui";
import { DiffViewer } from "../DiffViewer";

const SOURCE_LABELS: Record<string, string> = {
  "file-header": "File: header",
  "first-line-comment": "First-line comment",
  "preceding-text": "Preceding text",
  "language-hint": "Guessed",
  "delete-header": "Delete: directive",
  user: "You",
};

export function ResponsePanel({ width }: { width: number }): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  const rawResponse = useAppStore((state) => state.rawResponse);
  const parseResult = useAppStore((state) => state.parseResult);
  const includes = useAppStore((state) => state.includes);
  const applyResults = useAppStore((state) => state.applyResults);
  const applying = useAppStore((state) => state.applying);
  const setResponse = useAppStore((state) => state.setResponse);
  const setParsedPath = useAppStore((state) => state.setParsedPath);
  const toggleInclude = useAppStore((state) => state.toggleInclude);
  const applySelected = useAppStore((state) => state.applySelected);

  const [draft, setDraft] = useState(rawResponse);
  const [diffTarget, setDiffTarget] = useState<{
    path: string;
    content: string;
  } | null>(null);
  // Existence checks are keyed by the parse result they belong to, so a stale
  // result simply stops matching instead of needing a synchronous reset.
  const [existence, setExistence] = useState<{
    forResult: ParseResult | null;
    values: Record<string, boolean>;
  }>({ forResult: null, values: {} });
  const existing = existence.forResult === parseResult ? existence.values : {};

  useDebouncedEffect(
    () => {
      if (draft !== rawResponse) void setResponse(draft);
    },
    300,
    [draft],
  );

  useEffect(() => {
    if (!projectRoot || !parseResult) return;
    let cancelled = false;
    const checks = parseResult.files
      .filter(
        (file): file is typeof file & { path: string } => file.path !== null,
      )
      .map((file) =>
        window.LARPGent.diffFile({
          projectRoot,
          path: file.path,
          content: file.content,
        })
          .then((result) => [file.path, result.exists] as const)
          .catch(() => [file.path, false] as const),
      );
    void Promise.all(checks).then((entries) => {
      if (!cancelled)
        setExistence({
          forResult: parseResult,
          values: Object.fromEntries(entries),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, parseResult]);

  const includable = (parseResult?.files ?? []).filter(
    (file) => file.path !== null,
  );
  const selectedCount = includable.filter(
    (file, index) => includes[parsedFileKey(file, index)] === true,
  ).length;

  const deleteCount = includable.filter(
    (file, index) =>
      file.delete === true && includes[parsedFileKey(file, index)] === true,
  ).length;
  const writeCount = selectedCount - deleteCount;

  const confirmApply = (): void => {
    const lines: string[] = [];
    if (writeCount > 0) {
      lines.push(`${writeCount} file(s) will be written to disk.`);
    }
    if (deleteCount > 0) {
      lines.push(
        `${deleteCount} file(s) will be deleted — the contents are preserved as .bak siblings.`,
      );
    }
    const message =
      lines.join("\n") +
      "\n\nExisting files are backed up as .bak first. This cannot be undone from inside LARPGent.";
    if (window.confirm(message)) void applySelected();
  };

  return (
    <Panel
      title="AI Response"
      className="shrink-0 border-l"
      style={{ width }}
      actions={
        <>
          <Button
            variant="ghost"
            onClick={() => setDraft("")}
            disabled={draft === ""}
          >
            Clear
          </Button>
          <Button
            variant="primary"
            onClick={confirmApply}
            disabled={applying || selectedCount === 0}
          >
            {applying ? "Applying…" : `Apply ${selectedCount} file(s)`}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Paste the AI response here."
          spellCheck={false}
          className="h-40 shrink-0 resize-y border-b border-[#2c3038] bg-[#12141a] p-3 font-mono text-xs text-slate-200 outline-none"
        />

        <div className="min-h-0 flex-1 overflow-auto">
          {parseResult === null ? (
            <p className="p-3 text-xs text-slate-500">Nothing parsed yet.</p>
          ) : (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="rounded bg-[#2a2f38] px-2 py-0.5 text-slate-300">
                  strategy: {parseResult.strategy}
                </span>
                <span>{parseResult.files.length} block(s)</span>
              </div>

              {parseResult.warnings.map((warning) => (
                <Banner key={warning} tone="warn">
                  {warning}
                </Banner>
              ))}

              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="w-8 py-1 font-medium">Use</th>
                    <th className="py-1 font-medium">Path</th>
                    <th className="w-20 py-1 font-medium">Action</th>
                    <th className="w-24 py-1 font-medium">Kind</th>
                    <th className="w-28 py-1 font-medium">Path source</th>
                    <th className="w-14 py-1 font-medium">View</th>
                  </tr>
                </thead>
                <tbody>
                  {parseResult.files.map((file, index) => {
                    const key = parsedFileKey(file, index);
                    const known = file.path !== null;
                    const patchCount = file.patches?.length ?? 0;
                    const isPatch = patchCount > 0;
                    const isDelete = file.delete === true;
                    const action = !known
                      ? "—"
                      : existing[file.path] === undefined
                        ? "…"
                        : isDelete
                          ? existing[file.path]
                            ? "delete"
                            : "not found"
                          : existing[file.path]
                            ? "overwrite"
                            : "create";
                    return (
                      <tr
                        key={key}
                        className="border-t border-[#2c3038] align-top"
                      >
                        <td className="py-1.5">
                          <input
                            type="checkbox"
                            checked={includes[key] === true}
                            disabled={!known}
                            onChange={(event) =>
                              toggleInclude(key, event.target.checked)
                            }
                            className="size-3.5 accent-sky-500"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          {known ? (
                            <span className="font-mono text-slate-200">
                              {file.path}
                            </span>
                          ) : (
                            <input
                              key={key}
                              defaultValue=""
                              placeholder="type a target path…"
                              onBlur={(event) => {
                                const value = event.target.value.trim();
                                if (value !== "") setParsedPath(index, value);
                              }}
                              className="w-full rounded border border-amber-700 bg-[#12141a] px-1.5 py-1 font-mono text-amber-200 placeholder:text-amber-700/70"
                            />
                          )}
                        </td>
                        <td className="py-1.5 text-slate-400">{action}</td>
                        <td className="py-1.5">
                          {isDelete ? (
                            <span
                              title="Delete directive — the file is renamed to a .bak sibling"
                              className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-300"
                            >
                              delete
                            </span>
                          ) : isPatch ? (
                            <span
                              title={`${patchCount} SEARCH/REPLACE pair(s) — applied against the file on disk`}
                              className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
                            >
                              patch×{patchCount}
                            </span>
                          ) : (
                            <span className="text-slate-400">
                              {file.language ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-slate-400">
                          {SOURCE_LABELS[file.pathSource] ?? file.pathSource}
                        </td>
                        <td className="py-1.5">
                          <Button
                            variant="ghost"
                            disabled={!known || isDelete}
                            onClick={() => {
                              if (file.path)
                                setDiffTarget({
                                  path: file.path,
                                  content: file.content,
                                });
                            }}
                            title={
                              isDelete
                                ? "No diff to show for a delete"
                                : isPatch
                                  ? "Show the raw SEARCH/REPLACE text the AI proposed"
                                  : "Diff against the file on disk"
                            }
                          >
                            {isDelete ? "—" : isPatch ? "Patch" : "Diff"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {applyResults ? (
                <div className="flex flex-col gap-1">
                  <Banner
                    tone={
                      applyResults.some((r) => r.status === "failed")
                        ? "error"
                        : "success"
                    }
                  >
                    {summarize(applyResults)}
                  </Banner>
                  <ul className="font-mono text-xs text-slate-400">
                    {applyResults.map((result) => (
                      <li key={result.path} className="truncate">
                        {result.status}: {result.path}
                        {result.backupPath
                          ? ` (backup: ${result.backupPath})`
                          : ""}
                        {result.error ? ` — ${result.error}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {diffTarget ? (
        <DiffViewer
          path={diffTarget.path}
          content={diffTarget.content}
          onClose={() => setDiffTarget(null)}
        />
      ) : null}
    </Panel>
  );
}

function summarize(results: { status: string }[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
}