import { useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  useResearchStore,
  type ResearchTab,
} from "../../stores/research-store";
import { Banner, Button, Panel } from "../../lib/ui";

const COMPACT = "px-2 py-0.5 text-xs";

/**
 * Centre panel of research mode: the prompt builder and the index controls.
 *
 * Two tabs because the two jobs are genuinely different acts. Building the
 * index is a one-off, paid, several-minute operation on the session's
 * documents; building a prompt is a per-question action that costs nothing
 * locally. Putting the index rebuild next to the Build prompt button is how a
 * user re-embeds a corpus they already embedded.
 *
 * The prompt preview is a `<pre>`, not Monaco: the text here is read, copied,
 * and sent, never edited. Monaco would add a virtualised editor for a
 * read-only block, and the one thing the panel needs — select-all and copy —
 * a `<pre>` already does.
 */
export function ResearchDashboard(): ReactElement {
  const documents = useResearchStore((state) => state.documents);
  const selected = useResearchStore((state) => state.selected);
  const index = useResearchStore((state) => state.index);
  const indexBuilding = useResearchStore((state) => state.indexBuilding);
  const indexProgress = useResearchStore((state) => state.indexProgress);
  const promptMode = useResearchStore((state) => state.promptMode);
  const question = useResearchStore((state) => state.question);
  const topK = useResearchStore((state) => state.topK);
  const rerank = useResearchStore((state) => state.rerank);
  const prompt = useResearchStore((state) => state.prompt);
  const promptResult = useResearchStore((state) => state.promptResult);
  const buildingPrompt = useResearchStore((state) => state.buildingPrompt);
  const error = useResearchStore((state) => state.error);
  const notice = useResearchStore((state) => state.notice);

  const setPromptMode = useResearchStore((state) => state.setPromptMode);
  const setQuestion = useResearchStore((state) => state.setQuestion);
  const setTopK = useResearchStore((state) => state.setTopK);
  const setRerank = useResearchStore((state) => state.setRerank);
  const buildPrompt = useResearchStore((state) => state.buildPrompt);
  const buildIndex = useResearchStore((state) => state.buildIndex);
  const clearNotice = useResearchStore((state) => state.clearNotice);

  const tab = useResearchStore((state) => state.tab);
  const setTab = useResearchStore((state) => state.setTab);
  const copyPrompt = useResearchStore((state) => state.copyPrompt);
  const savePrompt = useResearchStore((state) => state.savePrompt);

  const converted = useMemo(
    () => documents.filter((document) => document.convertedExists),
    [documents],
  );
  const convertible = selected.length > 0 ? selected.length : converted.length;

  const headerActions: ReactNode =
    tab === "prompt" ? (
      <>
        <span className="text-xs text-slate-500">
          {converted.length} converted · {convertible} in prompt
        </span>
        <Button
          variant="primary"
          onClick={() => void buildPrompt()}
          disabled={buildingPrompt || converted.length === 0}
        >
          {buildingPrompt ? "Building…" : "Build prompt"}
        </Button>
        <Button
          variant="ghost"
          className={COMPACT}
          disabled={prompt === ""}
          onClick={() => copyPrompt()}
        >
          Copy
        </Button>
        <Button
          variant="ghost"
          className={COMPACT}
          disabled={prompt === ""}
          onClick={() => void savePrompt()}
        >
          Save…
        </Button>
      </>
    ) : (
      <>
        <span className="text-xs text-slate-500">
          {index.built
            ? `${index.chunkCount.toLocaleString()} chunks · ${index.documentCount} docs`
            : "no index"}
        </span>
        <Button
          variant="primary"
          onClick={() => void buildIndex()}
          disabled={indexBuilding || converted.length === 0}
        >
          {indexBuilding ? "Indexing…" : index.built ? "Rebuild index" : "Build index"}
        </Button>
      </>
    );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[#2c3038] px-2 pt-1">
        {(
          [
            ["prompt", "Prompt"],
            ["index", "Index"],
          ] as [ResearchTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition ${
              tab === id
                ? "border-sky-500 text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Panel
        title={tab === "prompt" ? "Research Prompt" : "Retrieval Index"}
        className="min-h-0 flex-1"
        actions={headerActions}
      >
        <div className="flex h-full min-h-0 flex-col">
          {error !== null ? (
            <div className="shrink-0 p-2">
              <Banner tone="error">{error}</Banner>
            </div>
          ) : null}
          {notice !== null ? (
            <div className="shrink-0 p-2">
              <div className="flex items-start gap-2">
                <Banner tone="info">{notice}</Banner>
                <Button
                  variant="ghost"
                  className={COMPACT}
                  onClick={clearNotice}
                  aria-label="Dismiss"
                >
                  ✕
                </Button>
              </div>
            </div>
          ) : null}

          {tab === "prompt" ? (
            <>
              <div className="shrink-0 space-y-2 border-b border-[#2c3038] p-2">
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="research-prompt-mode"
                      className="size-3.5 accent-sky-500"
                      checked={promptMode === "full"}
                      onChange={() => setPromptMode("full")}
                    />
                    Whole documents
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="research-prompt-mode"
                      className="size-3.5 accent-sky-500"
                      checked={promptMode === "rag"}
                      onChange={() => setPromptMode("rag")}
                    />
                    Retrieval (RAG)
                  </label>
                  <span className="text-[11px] text-slate-500">
                    {promptMode === "full"
                      ? "Every converted document, inlined. No question needed."
                      : "Top excerpts for a question, with one abstract per source document."}
                  </span>
                </div>

                {promptMode === "rag" ? (
                  <div className="space-y-2">
                    <textarea
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      rows={3}
                      placeholder="How do these papers differ in their approach to sampling?"
                      className="w-full resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 text-xs text-slate-200 outline-none focus:border-sky-600"
                    />
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                      <label className="flex items-center gap-1.5">
                        excerpts
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={topK}
                          onChange={(event) =>
                            setTopK(
                              Math.max(
                                1,
                                Math.min(50, Number(event.target.value) || 8),
                              ),
                            )
                          }
                          className="w-14 rounded border border-[#2c3038] bg-[#12141a] px-1 py-0.5 text-slate-200 outline-none focus:border-sky-600"
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-sky-500"
                          checked={rerank}
                          onChange={(event) => setRerank(event.target.checked)}
                        />
                        re-rank with the chat provider
                      </label>
                    </div>
                    {!index.built ? (
                      <Banner tone="warn">
                        No retrieval index yet. Build one on the Index tab
                        first — the Google key is what embeds the question and
                        the chunks.
                      </Banner>
                    ) : null}
                  </div>
                ) : null}

                {promptResult !== null ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span>
                      {promptResult.tokenCount.toLocaleString()} prompt tokens
                    </span>
                    <span>· {promptResult.documentCount} document(s)</span>
                    {promptResult.chunkCount > 0 ? (
                      <span>· {promptResult.chunkCount} excerpt(s)</span>
                    ) : null}
                    {promptResult.unreadable.length > 0 ? (
                      <span className="text-amber-400">
                        · {promptResult.unreadable.length} unreadable
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {promptResult !== null && promptResult.citations.length > 0 ? (
                  <ul className="max-h-24 overflow-auto text-[11px] text-slate-500">
                    {promptResult.citations.map((citation, index) => (
                      <li key={`${citation.document}-${index}`}>
                        {citation.document} — {citation.heading}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-2">
                {prompt === "" ? (
                  <p className="max-w-md text-xs leading-relaxed text-slate-500">
                    Convert some documents on the left, then press Build
                    prompt. The prompt appears here and is piped to the AI
                    Response panel on the right the same way a coding prompt
                    is — paste it into the chat, bring the answer back, and
                    the apply engine handles the rest.
                  </p>
                ) : (
                  <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300">
                    {prompt}
                  </pre>
                )}
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs text-slate-400">
              <p className="max-w-2xl leading-relaxed">
                The index holds one vector per excerpt, built with Google{" "}
                <code className="rounded bg-[#2a2f38] px-1">
                  text-embedding-004
                </code>{" "}
                at 768 dimensions. Rebuilding re-embeds every converted
                document — it is the only operation in the app that costs
                money without producing anything the user can see.
              </p>
              <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-slate-500">Documents</dt>
                <dd>{index.documentCount}</dd>
                <dt className="text-slate-500">Excerpts</dt>
                <dd>{index.chunkCount.toLocaleString()}</dd>
                <dt className="text-slate-500">Model</dt>
                <dd>{index.model ?? "—"}</dd>
                <dt className="text-slate-500">Dimensions</dt>
                <dd>{index.dimensions === 0 ? "—" : index.dimensions}</dd>
                <dt className="text-slate-500">Built</dt>
                <dd>
                  {index.builtAt === null
                    ? "—"
                    : new Date(index.builtAt).toLocaleString()}
                </dd>
              </dl>

              {indexProgress !== null ? (
                <p className="text-slate-300">
                  {indexProgress.message}
                  {indexProgress.total > 0
                    ? ` (${indexProgress.done}/${indexProgress.total})`
                    : ""}
                </p>
              ) : null}

              {selected.length > 0 ? (
                <p>
                  The build covers the {selected.length} selected document(s)
                  from the list on the left.
                </p>
              ) : (
                <p>
                  No selection — the build covers every converted document.
                </p>
              )}

              {converted.length === 0 ? (
                <Banner tone="warn">
                  Nothing has been converted yet, so there is nothing to
                  embed.
                </Banner>
              ) : null}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
