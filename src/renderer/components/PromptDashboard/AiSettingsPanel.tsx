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
 * The panel also hosts the "Send to web chat" target picker. That path does
 * not use an API key at all: it drives the site's own web UI in a dedicated
 * Electron window, reusing whatever session the user is signed into.
 *
 * The panel always renders something. A missing component or a silently
 * failing IPC call were both producing a blank tab because the early
 * `return` statements produced no visible output on some paths; every
 * branch below now returns JSX.
 */
export function AiSettingsPanel(): ReactElement {
  const providers = useAppStore((state) => state.aiProviders);
  const webChatTargets = useAppStore((state) => state.webChatTargets);
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

  const activeWebChat = webChatTargets.find(
    (t) => t.id === settings.webChatTarget,
  ) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <p className="mb-3 max-w-2xl text-xs text-slate-400">
        Pick a provider and paste an API key for the chat-completion path. The
        key is stored encrypted in your OS keychain and is only used from the
        main process — it never reaches the web view.
        <strong> GitNexus only</strong> runs entirely offline and needs no
        key; <strong>GitNexus + Jev</strong> uses the TypeSafe key and does
        not contact a chat provider. The <strong>web chat</strong> path below
        uses neither — it drives the chat site&rsquo;s own UI.
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

      <div className="mb-6">
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Web chat target
        </label>
        <p className="mb-2 max-w-2xl text-[11px] text-slate-500">
          Where <strong>Send to web chat</strong> on the Prompt tab goes. The
          app opens the site in a dedicated window, types the prompt into its
          composer, submits it, and scrapes the reply back into the AI
          Response panel. No API key and no per-token billing — the site is
          the model. Sign in once and the session is kept until you close
          that window. Each site&rsquo;s markup changes on its own schedule;
          if a send ever fails with &ldquo;could not find the chat
          input&rdquo;, open the window and finish signing in first.
        </p>
        <div className="flex flex-wrap gap-2">
          {webChatTargets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => void save({ webChatTarget: t.id })}
              className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
                settings.webChatTarget === t.id
                  ? "border-sky-500 bg-sky-950/40 text-sky-100"
                  : "border-[#2c3038] text-slate-300 hover:border-slate-500"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeWebChat ? (
          <div className="mt-2">
            <a
              href={activeWebChat.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[11px] text-slate-500 hover:text-slate-300"
              title={activeWebChat.url}
            >
              {activeWebChat.url}
            </a>
            <p className="mt-1 text-[11px] text-slate-500">
              The chat window is opened from the header — see{" "}
              <strong>Open chat</strong> next to the Coding / Research
              toggle.
            </p>
          </div>
        ) : null}
      </div>

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
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[#2c3038] px-3 py-2 text-xs transition hover:border-slate-500">
            <input
              type="radio"
              name="suggest-method"
              className="mt-0.5 size-3.5 shrink-0 accent-sky-500"
              checked={settings.suggestMethod === "gitnexus-jev"}
              onChange={() => void save({ suggestMethod: "gitnexus-jev" })}
            />
            <span>
              <span className="block font-medium text-slate-200">
                GitNexus + Jev — local recall, typed-decision precision
              </span>
              <span className="block text-[11px] text-slate-500">
                Same recall front half as the GitNexus method — GitNexus
                graph queries, BM25 fallback, git-history reranking — then
                each surviving candidate is scored by Jev on a 0–3
                relevance scale. Score 3 with ≥85% confidence is included;
                score 2 is flagged for your review; 0–1 is dropped. Uses
                the <strong>TypeSafe</strong> API key, not a chat provider,
                and every judgment comes back with a calibrated
                probability you can act on. Requires the{" "}
                <code className="rounded bg-[#2a2f38] px-1">gitnexus</code>{" "}
                CLI on your PATH for graph-query recall; without it only
                BM25 recall runs.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[#2c3038] px-3 py-2 text-xs transition hover:border-slate-500">
            <input
              type="radio"
              name="suggest-method"
              className="mt-0.5 size-3.5 shrink-0 accent-sky-500"
              checked={settings.suggestMethod === "gitnexus-llm"}
              onChange={() => void save({ suggestMethod: "gitnexus-llm" })}
            />
            <span>
              <span className="block font-medium text-slate-200">
                GitNexus + LLM — local recall, chat-model precision
              </span>
              <span className="block text-[11px] text-slate-500">
                Same recall front half as the other two methods — GitNexus
                graph queries, BM25 fallback, git-history reranking — but
                the surviving candidates are rated by whichever{" "}
                <strong>chat provider</strong> is selected above
                (DeepSeek, Groq, OpenRouter, or Google AI Studio) on the
                same 0–3 scale. Score 3 with ≥85% confidence is included;
                score 2 is flagged for your review; 0–1 is dropped. The
                confidence here is the model&rsquo;s own self-report, not a
                calibrated probability, so treat the include bucket as a
                strong hint rather than a guarantee. Use this when you
                have a chat-provider key but no TypeSafe key, or to compare
                a general model&rsquo;s ranking against Jev&rsquo;s on the same
                project. Requires the{" "}
                <code className="rounded bg-[#2a2f38] px-1">gitnexus</code>{" "}
                CLI on your PATH for graph-query recall; without it only
                BM25 recall runs.
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