import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { PlanStep } from "@shared/types";
import { useAppStore } from "../../stores/app-store";
import { Banner, Button, Panel } from "../../lib/ui";

const STATUS_MARK: Record<PlanStep["status"], string> = {
  done: "✓",
  active: "▶",
  pending: "○",
  blocked: "!",
};

const STATUS_CLASS: Record<PlanStep["status"], string> = {
  done: "text-emerald-400 line-through",
  active: "text-sky-300",
  pending: "text-slate-400",
  blocked: "text-amber-400",
};

export function SessionPanel(): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  const session = useAppStore((state) => state.session);
  const prompt = useAppStore((state) => state.sessionPrompt);
  const summaries = useAppStore((state) => state.sessionSummaries);
  const busy = useAppStore((state) => state.sessionBusy);
  const progress = useAppStore((state) => state.sessionProgress);
  const notice = useAppStore((state) => state.sessionNotice);
  const error = useAppStore((state) => state.error);
  const createSession = useAppStore((state) => state.createSession);
  const loadSession = useAppStore((state) => state.loadSession);
  const submitSessionResponse = useAppStore((state) => state.submitSessionResponse);
  const cancelSession = useAppStore((state) => state.cancelSession);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const togglePlanStep = useAppStore((state) => state.togglePlanStep);
  const clearSessionNotice = useAppStore((state) => state.clearSessionNotice);
  const refreshSessionList = useAppStore((state) => state.refreshSessionList);

  const [task, setTask] = useState("");
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState(false);

  // The most recent rollback, if the last turn ended in one. Derived from the
  // turn list rather than stored separately so it survives a session reload
  // and cannot drift from the record it describes.
  const lastRegression = (() => {
    if (session === null) return null;
    const turn = session.turns[session.turns.length - 1];
    if (!turn || turn.regression === undefined) return null;
    return { turn: turn.index, message: turn.regression };
  })();

  useEffect(() => {
    if (projectRoot) void refreshSessionList();
  }, [projectRoot, refreshSessionList]);

  const copyPrompt = (): void => {
    if (prompt === null) return;
    void window.AnythingButProPlan.copyText(prompt.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const submit = (): void => {
    void submitSessionResponse(paste);
    setPaste("");
  };

  return (
    <Panel
      title="Session"
      className="shrink-0 border-l"
      actions={
        session !== null ? (
          <>
            <Button variant="ghost" onClick={() => void cancelSession()} disabled={!busy}>
              Stop
            </Button>
            <Button
              variant="ghost"
              onClick={() => void deleteSession(session.id)}
              disabled={busy}
            >
              Discard
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-xs">
        {!projectRoot ? (
          <Banner tone="info">Open a project to start a coding session.</Banner>
        ) : null}

        {error ? <Banner tone="error">{error}</Banner> : null}
        {notice ? (
          <Banner tone="info">
            <div className="flex items-start justify-between gap-2">
              <span>{notice}</span>
              <button className="text-slate-500 hover:text-slate-300" onClick={clearSessionNotice}>
                ×
              </button>
            </div>
          </Banner>
        ) : null}
        {progress ? (
          <div className="text-[11px] text-slate-500">
            {progress.phase}: {progress.message}
          </div>
        ) : null}

        {/* A rollback is the one event where the app changed the user's files
            back without being asked, so it gets a banner rather than a line in
            the turn list. The detail matters: it names the check that went
            red, which is what the next prompt feeds back to the model. */}
        {lastRegression ? (
          <Banner tone="warn">
            <div className="flex flex-col gap-1">
              <span className="font-semibold">
                Turn {lastRegression.turn} regressed and was rolled back.
              </span>
              <span className="whitespace-pre-wrap text-[11px]">
                {lastRegression.message}
              </span>
            </div>
          </Banner>
        ) : null}

        {session === null ? (
          <div className="flex flex-col gap-2">
            <label className="text-slate-400">New session — what should the model do?</label>
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Add retry handling to the ingest worker and cover it with a test."
              rows={4}
              className="resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 text-slate-200 outline-none"
            />
            <Button
              variant="primary"
              onClick={() => void createSession(task)}
              disabled={busy || !projectRoot || task.trim() === ""}
            >
              {busy ? "Starting…" : "Start session"}
            </Button>

            {summaries.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">Recent</span>
                {summaries.slice(0, 10).map((summary) => (
                  <div
                    key={summary.id}
                    className="flex items-center justify-between gap-2 rounded border border-[#232730] bg-[#181a20] px-2 py-1"
                  >
                    <button
                      className="truncate text-left text-slate-300 hover:text-white"
                      onClick={() => void loadSession(summary.id)}
                      title={summary.task}
                    >
                      {summary.task}
                    </button>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {summary.status} · {summary.turnCount}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="rounded border border-[#232730] bg-[#181a20] p-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Task</div>
              <div className="mt-1 whitespace-pre-wrap text-slate-200">{session.task}</div>
              <div className="mt-1 text-[10px] text-slate-500">
                status: {session.status} · turns: {session.turns.length} · budget:{" "}
                {session.contextBudget}
              </div>
            </div>

            {session.plan.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">Plan</span>
                {session.plan.map((step) => (
                  <button
                    key={step.id}
                    onClick={() => void togglePlanStep(step.id)}
                    className={`flex items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-[#1c2028] ${STATUS_CLASS[step.status]}`}
                    title="Click to cycle: pending → active → done"
                  >
                    <span className="mt-0.5 w-3 shrink-0">{STATUS_MARK[step.status]}</span>
                    <span>{step.text}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {session.turns.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">Turns</span>
                {session.turns.map((turn) => (
                  <div
                    key={`${turn.index}-${turn.createdAt}`}
                    className="rounded border border-[#232730] bg-[#181a20] px-2 py-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300">turn {turn.index}</span>
                      <span
                        className={
                          turn.outcome === "applied"
                            ? "text-emerald-400"
                            : turn.outcome === "regressed" || turn.outcome === "failed"
                              ? "text-red-400"
                              : "text-slate-400"
                        }
                      >
                        {turn.outcome ?? "pending"}
                      </span>
                    </div>
                    {turn.regression ? (
                      <div className="mt-1 text-[10px] text-amber-300">{turn.regression}</div>
                    ) : null}
                    {turn.applied && turn.applied.length > 0 ? (
                      <div className="mt-1 text-[10px] text-slate-500">
                        {turn.applied
                          .map((result) => `${result.path} (${result.status})`)
                          .join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {session.decisions.length > 0 ? (
              <details className="rounded border border-[#232730] bg-[#181a20] p-2">
                <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-slate-500">
                  Memory ({session.decisions.length})
                </summary>
                <ul className="mt-1 flex flex-col gap-1 text-[11px] text-slate-400">
                  {session.decisions.map((decision, index) => (
                    <li key={index}>{decision}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {prompt !== null ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">
                    Turn {prompt.turnIndex} prompt · ~{prompt.tokenCount} tokens
                  </span>
                  <Button variant="primary" onClick={copyPrompt}>
                    {copied ? "Copied" : "Copy prompt"}
                  </Button>
                </div>

                {/* The loop is stopped here by design — it cannot continue
                    until a reply comes back. Saying so beats leaving the user
                    to infer it from an empty paste box. */}
                <div className="rounded border border-sky-900 bg-[#0f1d2b] px-2 py-1 text-[11px] text-sky-300">
                  Waiting for a reply. Copy the prompt into the chat, then
                  paste the answer below.
                </div>
                {prompt.omittedPaths.length > 0 ? (
                  <div className="text-[10px] text-slate-500">
                    Omitted for budget: {prompt.omittedPaths.length} file(s) — the model can request
                    them with ===Need===.
                  </div>
                ) : null}
                <textarea
                  readOnly
                  value={prompt.prompt}
                  rows={8}
                  className="resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 font-mono text-[11px] text-slate-300 outline-none"
                />

                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  Paste the reply
                </span>
                <textarea
                  value={paste}
                  onChange={(event) => setPaste(event.target.value)}
                  placeholder="Paste the chat's full response here."
                  rows={6}
                  className="resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 font-mono text-[11px] text-slate-200 outline-none"
                />
                <Button
                  variant="primary"
                  onClick={submit}
                  disabled={busy || paste.trim() === ""}
                >
                  {busy ? "Working…" : "Submit response"}
                </Button>
              </div>
            ) : (
              <div className="text-[11px] text-slate-500">
                No prompt is waiting.{" "}
                {session.status === "green"
                  ? "The session finished green."
                  : session.status === "blocked"
                    ? "The session stopped — start a new session or discard this one."
                    : null}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
