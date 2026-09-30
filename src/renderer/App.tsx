import { useEffect } from "react";
import type { ReactElement } from "react";
import type { AppMode } from "@shared/types";
import { useAppStore } from "./stores/app-store";
import { subscribeResearchProgress } from "./stores/research-store";
import { DocumentTree } from "./components/DocumentTree";
import { FileTree } from "./components/FileTree";
import { PromptDashboard } from "./components/PromptDashboard";
import { ResearchDashboard } from "./components/ResearchDashboard";
import { ResponsePanel } from "./components/ResponsePanel";
import { useResizableWidth } from "./lib/hooks";
import { Banner, ResizeHandle } from "./lib/ui";

const MODES: { id: AppMode; label: string; title: string }[] = [
  {
    id: "coding",
    label: "Coding",
    title: "Source tree in, patch out",
  },
  {
    id: "research",
    label: "Research",
    title: "Document set in, cited answer out",
  },
];

export default function App(): ReactElement {
  const notice = useAppStore((state) => state.notice);
  const error = useAppStore((state) => state.error);
  const clearNotice = useAppStore((state) => state.clearNotice);
  const mode = useAppStore((state) => state.aiSettings?.mode ?? "coding");
  const loadAiSettings = useAppStore((state) => state.loadAiSettings);
  const saveAiSettings = useAppStore((state) => state.saveAiSettings);

  // Left panel: the divider sits to its right, so dragging right grows it.
  const fileTree = useResizableWidth(420, { min: 180, max: 640, sign: 1 });
  // Right panel: the divider sits to its left, so dragging right shrinks it.
  const response = useResizableWidth(560, { min: 320, max: 960, sign: -1 });

  // The mode lives in the persisted settings, and in research mode the
  // settings panel that would otherwise load them is not mounted — so the
  // load has to happen here, above the branch, or the toggle would always
  // start on coding mode regardless of what was saved.
  useEffect(() => {
    void loadAiSettings();
  }, [loadAiSettings]);

  // Conversion and index progress arrive as main-process events. Subscribed
  // here, above the mode branch, so a conversion started in research mode
  // keeps updating its progress bar if the user flips to coding mode and
  // back while it runs.
  useEffect(() => subscribeResearchProgress(), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[#2c3038] px-3 py-2">
        <h1 className="text-sm font-semibold text-slate-100">
          AnythingButProPlan
        </h1>
        <span className="text-xs text-slate-500">
          {mode === "research"
            ? "documents → prompt → cited answer"
            : "codebase → prompt → code"}
        </span>
        {/* One save per click: the mode is a field on the settings object,
            so it goes through the same `aiSaveSettings` call as every other
            field rather than a channel of its own. */}
        <div
          className="flex items-center gap-0.5 rounded border border-[#2c3038] p-0.5"
          role="group"
          aria-label="Mode"
        >
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.title}
              aria-pressed={mode === entry.id}
              onClick={() => void saveAiSettings({ mode: entry.id })}
              className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                mode === entry.id
                  ? "bg-sky-600 text-white"
                  : "text-slate-400 hover:bg-[#2a2f38] hover:text-slate-100"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {notice ? (
            <span className="text-xs text-emerald-400">{notice}</span>
          ) : null}
          {error ? (
            <div className="max-w-[520px]">
              <Banner tone="error">{error}</Banner>
            </div>
          ) : null}
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {mode === "research" ? (
          <DocumentTree width={fileTree.width} />
        ) : (
          <FileTree width={fileTree.width} />
        )}
        <ResizeHandle
          onMouseDown={fileTree.onMouseDown}
          label="Resize project panel"
        />
        {mode === "research" ? <ResearchDashboard /> : <PromptDashboard />}
        <ResizeHandle
          onMouseDown={response.onMouseDown}
          label="Resize response panel"
        />
        <ResponsePanel width={response.width} />
      </main>
    </div>
  );
}
