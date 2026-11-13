import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ParseResult } from "@shared/types";
import { useAppStore, parsedFileKey } from "../../stores/app-store";
import { useDebouncedEffect } from "../../lib/hooks";
import { Banner, Button, Panel } from "../../lib/ui";
import { DiffViewer } from "../DiffViewer";
import { DebugMonitor } from "./DebugMonitor";

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
  const mode = useAppStore((state) => state.aiSettings?.mode ?? "coding");
  const rawResponse = useAppStore((state) => state.rawResponse);
  const parseResult = useAppStore((state) => state.parseResult);
  const includes = useAppStore((state) => state.includes);
  const applyResults = useAppStore((state) => state.applyResults);
  const applying = useAppStore((state) => state.applying);
  const setResponse = useAppStore((state) => state.setResponse);
  const setParsedPath = useAppStore((state) => state.setParsedPath);
  const toggleInclude = useAppStore((state) => state.toggleInclude);
  const applySelected = useAppStore((state) => state.applySelected);
  const debugRunning = useAppStore((state) => state.debugRunning);
  const debugLog = useAppStore((state) => state.debugLog);
  const debugAutoRun = useAppStore((state) => state.debugAutoRun);
  const setDebugAutoRun = useAppStore((state) => state.setDebugAutoRun);
  const runDebugCommands = useAppStore((state) => state.runDebugCommands);

  const [draft, setDraft] = useState(rawResponse);
  const [showMonitor, setShowMonitor] = useState(false);
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

  // Mirror store-side changes into the textarea. Without this, the local
  // `draft` — which `useState` reads exactly once — would keep its initial
  // (usually empty) value. The equality guard stops the update from firing when
  // the change is our own debounced write, since at that point `draft` and
  // `rawResponse` already match.
  useEffect(() => {
    setDraft((current) => (current === rawResponse ? current : rawResponse));
  }, [rawResponse]);

  useDebouncedEffect(
    () => {
      if (draft !== rawResponse) void setResponse(draft);
    },
    300,
    [draft],
  );

  // Text pasted while in research mode was deliberately left unparsed. If the
  // user then switches to coding mode, that text is now a candidate patch and
  // has to be read — otherwise the panel sits on "Nothing parsed yet" with a
  // full response in the box.
  useEffect(() => {
    if (mode !== "coding") return;
    if (parseResult !== null || rawResponse.trim() === "") return;
    void setResponse(rawResponse);
  }, [mode, rawResponse, parseResult, setResponse]);

  useEffect(() => {
    if (debugRunning) {
      setShowMonitor(true);
    }
  }, [debugRunning]);

  useEffect(() => {
    if (!projectRoot || !parseResult) return;
    let cancelled = false;
    const checks = parseResult.files
      .filter((file) => file.kind !== "unresolved")
      .map((file) =>
        window.AnythingButProPlan.diffFile({
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
    (file) => file.kind !== "unresolved",
  );
  const selectedCount = includable.filter(
    (file, index) => includes[parsedFileKey(file, index)] === true,
  ).length;

  const deleteCount = includable.filter(
    (file, index) =>
      file.kind === "delete" && includes[parsedFileKey(file, index)] === true,
  ).length;
  const writeCount = selectedCount - deleteCount;
  const debugCommands = parseResult?.debugCommands ?? [];

  const confirmApply = async (): Promise<void> => {
    const lines: string[] = [];
    if (writeCount > 0) {
      lines.push(`${writeCount} file(s) will be written to disk.`);
    }
    if (deleteCount > 0) {
      lines.push(`${deleteCount} file(s) will be deleted.`);
    }
    const confirmed = await window.AnythingButProPlan.confirmDialog({
      message: `Apply ${selectedCount} file(s)?`,
      detail:
        lines.join("\n") +
        "\n\nGit source control is the safety net for anything that lands on disk.",
      confirmLabel: "Apply",
      tone: deleteCount > 0 ? "warning" : "question",
    });
    if (confirmed) void applySelected();
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
          {/* Apply and Run Debug act on the parsed file entries. In research
              mode the response is a cited answer, so there is nothing to
              write and no commands to run; showing the buttons would offer
              actions the mode cannot honour. */}
          {mode === "coding" ? (
            <>
              <Button
                variant="primary"
                onClick={() => void confirmApply()}
                disabled={applying || selectedCount === 0}
              >
                {applying ? "Applying…" : `Apply ${selectedCount} file(s)`}
              </Button>
              {debugCommands.length > 0 ? (
                <Button
                  onClick={() => {
                    setShowMonitor(true);
                    void runDebugCommands();
                  }}
                  disabled={debugRunning || !projectRoot}
                  title={
                    !projectRoot
                      ? "Open a project to run commands"
                      : "Run parsed debug commands"
                  }
                >
                  {debugRunning ? "Running…" : "Run Debug"}
                </Button>
              ) : null}
            </>
          ) : null}
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
          {mode !== "coding" ? (
            <p className="p-3 text-xs text-slate-500">
              The answer is above. Research replies are prose and citations —
              there is no file list to apply.
            </p>
          ) : parseResult === null ? (
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
                    const path = file.kind === "unresolved" ? null : file.path;
                    const isPatch = file.kind === "patch";
                    const isDelete = file.kind === "delete";
                    const patchCount = isPatch ? file.patches.length : 0;
                    const action =
                      path === null
                        ? "—"
                        : existing[path] === undefined
                          ? "…"
                          : isDelete
                            ? existing[path]
                              ? "delete"
                              : "not found"
                            : existing[path]
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
                            disabled={path === null}
                            onChange={(event) =>
                              toggleInclude(key, event.target.checked)
                            }
                            className="size-3.5 accent-sky-500"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          {path !== null ? (
                            <span className="font-mono text-slate-200">
                              {path}
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
                              title="Delete directive — the file is removed from disk"
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
                            disabled={path === null || isDelete}
                            onClick={() => {
                              if (path !== null)
                                setDiffTarget({ path, content: file.content });
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

              {debugCommands.length > 0 ? (
                <div className="flex flex-col gap-2 rounded border border-[#2c3038] bg-[#12141a] p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-300">
                        Debug Commands
                      </span>
                      <span className="rounded bg-[#2a2f38] px-1.5 py-0.5 text-[11px] text-slate-400">
                        {debugCommands.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {debugLog ? (
                        <Button
                          variant="ghost"
                          onClick={() => setShowMonitor((prev) => !prev)}
                        >
                          {showMonitor ? "Hide Monitor" : "View Monitor"}
                        </Button>
                      ) : null}
                      <Button
                        variant="primary"
                        onClick={() => {
                          setShowMonitor(true);
                          void runDebugCommands();
                        }}
                        disabled={debugRunning || !projectRoot}
                        title={
                          !projectRoot
                            ? "Open a project to run commands"
                            : "Run debug commands one by one"
                        }
                      >
                        {debugRunning ? "Running…" : "Run Debug"}
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    {debugCommands.map((cmd, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 rounded border border-[#232730] bg-[#181a20] px-2.5 py-1 font-mono text-xs text-slate-300"
                      >
                        <span className="font-semibold text-emerald-400">$</span>
                        <span className="truncate select-all">{cmd}</span>
                      </div>
                    ))}
                  </div>

                  <label className="flex items-center gap-2 text-[11px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={debugAutoRun}
                      onChange={(event) => setDebugAutoRun(event.target.checked)}
                    />
                    Run without asking for confirmation (this app session only)
                  </label>
                </div>
              ) : null}

              {showMonitor ? (
                <DebugMonitor onClose={() => setShowMonitor(false)} />
              ) : null}

              {applyResults ? (
                <div className="flex flex-col gap-1">
                  <Banner
                    tone={
                      applyResults.some((r) => r.status === "failed")
                        ? "error"
                        : "success"
                    }
                  >
                    <div className="flex items-center justify-between w-full">
                      <span>{summarize(applyResults)}</span>
                      {debugCommands.length > 0 ? (
                        <Button
                          variant="ghost"
                          className="text-xs px-2 py-0.5"
                          onClick={() => {
                            setShowMonitor(true);
                            void runDebugCommands();
                          }}
                          disabled={debugRunning || !projectRoot}
                        >
                          Run Debug
                        </Button>
                      ) : null}
                    </div>
                  </Banner>
                  <ul className="font-mono text-xs text-slate-400">
                    {applyResults.map((result) => (
                      <li key={result.path} className="truncate">
                        {result.status}: {result.path}
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