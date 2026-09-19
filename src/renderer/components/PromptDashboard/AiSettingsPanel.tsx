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