import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AiProviderId } from "@shared/types";
import { useAppStore } from "../../stores/app-store";
import { Banner, Button } from "../../lib/ui";

/**
 * Settings tab for the AI file-selection feature. Two things live here:
 * which provider to call, and the API key for it. The key is written
 * through IPC, stored encrypted in `userData`, and never read back into the
 * renderer — the field below is write-only by design.
 *
 * The panel always renders something. A missing component or a silently
 * failing IPC call were both producing a blank tab because the early
 * `return` statements produced no visible output on some paths; every
 * branch below now returns JSX.
 */
export function AiSettingsPanel(): ReactElement {
  const providers = useAppStore((state) => state.aiProviders);
  const settings = useAppStore((state) => state.aiSettings);
  const loading = useAppStore((state) => state.aiSettingsLoading);
  const load = useAppStore((state) => state.loadAiSettings);
  const save = useAppStore((state) => state.saveAiSettings);

  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the key draft whenever the selected provider changes, so a key
  // typed for one provider is not accidentally saved to another.
  useEffect(() => {
    setKeyDraft("");
  }, [settings?.provider]);

  if (loading && !settings) {
    return (
      <div className="min-h-0 flex-1 p-3 text-xs text-slate-500">
        Loading AI settings…
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="min-h-0 flex-1 p-3">
        <Banner tone="error">
          Failed to load AI settings. Check the terminal for the underlying
          error, then retry by switching to another tab and back.
        </Banner>
      </div>
    );
  }

  const selected: AiProviderId | null = settings.provider;
  const activeProvider = providers.find((p) => p.id === selected) ?? null;
  const hasKey = selected ? settings.hasApiKey[selected] === true : false;
  const currentModel = selected
    ? settings.modelByProvider[selected] ?? activeProvider?.models[0] ?? ""
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <p className="mb-3 max-w-2xl text-xs text-slate-400">
        Pick a provider and paste an API key. The key is stored encrypted in
        your OS keychain and is only used from the main process — it never
        reaches the web view. Free tiers are available from all four
        providers; DeepSeek and Google AI Studio offer the most headroom.
        The <strong>GitNexus only</strong> method runs entirely offline and
        does not use an API key at all.
      </p>

      {providers.length === 0 ? (
        <div className="mb-4">
          <Banner tone="warn">
            No AI providers are registered. This means the main process failed
            to load the provider catalogue — check the terminal for errors
            before selecting anything here.
          </Banner>
        </div>
      ) : null}

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-400">
          File suggestion method
        </label>
        <div className="flex max-w-2xl flex-col gap-2">
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[#2c3038] px-3 py-2 text-xs transition hover:border-slate-500">
            <input
              type="radio"
              name="suggest-method"
              className="mt-0.5 size-3.5 shrink-0 accent-sky-500"
              checked={settings.suggestMethod === "current"}
              onChange={() => void save({ suggestMethod: "current" })}
            />
            <span>
              <span className="block font-medium text-slate-200">
                Current — full skeleton map
              </span>
              <span className="block text-[11px] text-slate-500">
                Sends a skeleton of every file in the project to the model in
                a single call. Simple and reliable, but the request grows
                linearly with the size of the project, and a large repository
                can easily exceed what a provider will accept.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[#2c3038] px-3 py-2 text-xs transition hover:border-slate-500">
            <input
              type="radio"
              name="suggest-method"
              className="mt-0.5 size-3.5 shrink-0 accent-sky-500"
              checked={settings.suggestMethod === "gitnexus"}
              onChange={() => void save({ suggestMethod: "gitnexus" })}
            />
            <span>
              <span className="block font-medium text-slate-200">
                GitNexus — hybrid search, targeted skeleton
              </span>
              <span className="block text-[11px] text-slate-500">
                Two-stage pipeline: the model expands your instruction into
                search terms blind, then local GitNexus graph queries and a
                BM25 fallback pick 20–40 candidates, git history reranks
                them, and only those files are sent back for the final
                ranking. Requires the{" "}
                <code className="rounded bg-[#2a2f38] px-1">gitnexus</code>{" "}
                CLI on your PATH — without it the pipeline still runs, but
                the graph-query half is skipped and only BM25 search is used.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[#2c3038] px-3 py-2 text-xs transition hover:border-slate-500">
            <input
              type="radio"
              name="suggest-method"
              className="mt-0.5 size-3.5 shrink-0 accent-sky-500"
              checked={settings.suggestMethod === "gitnexus-only"}
              onChange={() => void save({ suggestMethod: "gitnexus-only" })}
            />
            <span>
              <span className="block font-medium text-slate-200">
                GitNexus only — local search, no AI call
              </span>
              <span className="block text-[11px] text-slate-500">
                Same recall and rerank front half as the GitNexus method —
                GitNexus graph queries, BM25 fallback, git-history
                reranking — but the ranked candidate list <em>is</em> the
                answer. No model call, no API key required, zero token
                cost. Keywords come from the instruction text itself
                rather than an LLM expansion, so natural-language
                descriptions of behaviour land less precisely than the
                other two methods. Requires the{" "}
                <code className="rounded bg-[#2a2f38] px-1">gitnexus</code>{" "}
                CLI on your PATH; without it only BM25 search runs.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Provider
        </label>
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void save({ provider: p.id })}
              className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
                selected === p.id
                  ? "border-sky-500 bg-sky-950/40 text-sky-100"
                  : "border-[#2c3038] text-slate-300 hover:border-slate-500"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {activeProvider ? (
        <>
          <div className="mb-4">
            <label className="mb-1 block text-xs font-medium text-slate-400">
              Model
            </label>
            <div className="flex flex-wrap gap-2">
              {activeProvider.models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    void save({
                      model: { provider: activeProvider.id, model: m },
                    })
                  }
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition ${
                    currentModel === m
                      ? "border-sky-500 bg-sky-950/40 text-sky-100"
                      : "border-[#2c3038] text-slate-400 hover:border-slate-500"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label
              htmlFor="ai-api-key"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              API key
              {hasKey ? (
                <span className="ml-2 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  saved
                </span>
              ) : null}
            </label>
            <div className="flex gap-2">
              <input
                id="ai-api-key"
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={
                  hasKey
                    ? "••••••• (type a new key to replace)"
                    : "paste key here"
                }
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-[#2c3038] bg-[#12141a] px-2 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-sky-600"
              />
              <Button
                variant="primary"
                className="px-3 py-1.5 text-xs"
                disabled={keyDraft.trim() === ""}
                onClick={() => {
                  const key = keyDraft.trim();
                  void save({
                    apiKey: { provider: activeProvider.id, key },
                  }).then(() => setKeyDraft(""));
                }}
              >
                Save key
              </Button>
              {hasKey ? (
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 text-xs"
                  onClick={() =>
                    void save({
                      apiKey: { provider: activeProvider.id, key: "" },
                    })
                  }
                  title="Remove the stored key for this provider"
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Get a key at{" "}
              <a
                href={activeProvider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:text-sky-300"
              >
                {activeProvider.keyUrl}
              </a>
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}