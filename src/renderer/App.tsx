import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AppMode } from "@shared/types";
import { useAppStore } from "./stores/app-store";
import { subscribeResearchProgress } from "./stores/research-store";
import { DocumentTree } from "./components/DocumentTree";
import { FileTree } from "./components/FileTree";
import { PromptDashboard } from "./components/PromptDashboard";
import { ResearchDashboard } from "./components/ResearchDashboard";
import { ResponsePanel } from "./components/ResponsePanel";
import { SessionPanel } from "./components/SessionPanel";
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

type RightPane = "response" | "session";

export default function App(): ReactElement {
  const notice = useAppStore((state) => state.notice);
  const error = useAppStore((state) => state.error);
  const clearNotice = useAppStore((state) => state.clearNotice);
  const mode = useAppStore((state) => state.aiSettings?.mode ?? "coding");
  const loadAiSettings = useAppStore((state) => state.loadAiSettings);
  const saveAiSettings = useAppStore((state) => state.saveAiSettings);
  const setSessionProgress = useAppStore((state) => state.setSessionProgress);
  // Left panel: divider sits to its right, so dragging right grows it.
  const fileTree = useResizableWidth(420, { min: 180, max: 640, sign: 1 });
  // Right panel: divider sits to its left, so dragging right shrinks it.
  const response = useResizableWidth(560, { min: 320, max: 960, sign: -1 });

  const [rightPane, setRightPane] = useState<RightPane>("response");

  // mode lives in persisted settings, and in research mode the
  // settings panel would otherwise load them not mounted — so the
  // load has happen here, above branch, or toggle would always
  // start on coding mode regardless was saved.
  useEffect(() => {
    void loadAiSettings();
  }, [loadAiSettings]);

  // Conversion and index progress arrive main-process events. Subscribed
  // here, above mode branch, so conversion started in research mode
  // keeps updating progress bar if user flips to coding mode and
  // back while it runs.
  useEffect(() => subscribeResearchProgress(), []);

  // Session progress is main-process events too. Subscribed once at the top
  // so a turn that finishes while the user is on another pane still updates
  // the store.
  useEffect(() => {
    const unsubscribe = window.AnythingButProPlan.onSessionProgress((event) => {
      setSessionProgress(event);
    });
    return unsubscribe;
  }, [setSessionProgress]);

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
        {mode === "coding" ? (
          <div
            className="flex items-center gap-0.5 rounded border border-[#2c3038] p-0.5"
            role="group"
            aria-label="Right panel"
          >
            {(["response", "session"] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                aria-pressed={rightPane === pane}
                onClick={() => setRightPane(pane)}
                className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                  rightPane === pane
                    ? "bg-sky-600 text-white"
                    : "text-slate-400 hover:bg-[#2a2f38] hover:text-slate-100"
                }`}
              >
                {pane === "response" ? "Response" : "Session"}
              </button>
            ))}
          </div>
        ) : null}
        {/* One save per click: mode is a field on the settings object,
        so it goes through the same `aiSaveSettings` call every other
        field does rather than a channel of its own. */}
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
            <Banner tone="error">{error}</Banner>
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
          label="Resize right panel"
        />
        {mode === "coding" && rightPane === "session" ? (
          <SessionPanel />
        ) : (
          <ResponsePanel width={response.width} />
        )}
      </main>
    </div>
  );
}
