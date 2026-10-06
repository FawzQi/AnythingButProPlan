import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { useAppStore } from "../../stores/app-store";
import { countFiles } from "../../lib/tree";
import { insertCustomPrompt } from "../../lib/prompt";
import { Banner, Button, Panel } from "../../lib/ui";
import { SourceControl } from "../SourceControl";
import { AiSettingsPanel } from "./AiSettingsPanel";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-xs font-medium transition ${
        active
          ? "border-sky-500 text-slate-100"
          : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

function PromptTab(): ReactElement {
  const prompt = useAppStore((state) => state.prompt);
  const tokenCount = useAppStore((state) => state.tokenCount);
  const promptFileCount = useAppStore((state) => state.promptFileCount);
  const unreadable = useAppStore((state) => state.unreadable);
  const sensitiveFiles = useAppStore((state) => state.sensitiveFiles);
  const customPrompt = useAppStore((state) => state.customPrompt);
  const setCustomPrompt = useAppStore((state) => state.setCustomPrompt);
  const aiSettings = useAppStore((state) => state.aiSettings);
  const aiSuggesting = useAppStore((state) => state.aiSuggesting);
  const aiLastSuggestion = useAppStore((state) => state.aiLastSuggestion);
  const mapTokenCount = useAppStore((state) => state.mapTokenCount);
  const suggestFiles = useAppStore((state) => state.suggestFiles);
  const setEditorTab = useAppStore((state) => state.setEditorTab);

  // What the user actually sees and copies: the built base prompt with the
  // current additional instructions appended. Recomputing here (rather than at
  // build time) means an edit to the textarea lands immediately, without
  // re-reading files.
  const effectivePrompt = useMemo(
    () => insertCustomPrompt(prompt, customPrompt),
    [prompt, customPrompt],
  );

  // Token count of the effective prompt. When there is no custom section the
  // build-time count is exact; when there is one, recompute via IPC —
  // debounced so typing does not flood the main process.
  const [customTokens, setCustomTokens] = useState<number | null>(null);
  useEffect(() => {
    if (prompt === "" || customPrompt.trim() === "") {
      setCustomTokens(null);
      return;
    }
    const timer = setTimeout(() => {
      void window.AnythingButProPlan.countTokens(effectivePrompt).then(
        setCustomTokens,
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [effectivePrompt, customPrompt, prompt]);

  const displayTokens = customTokens ?? tokenCount;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {unreadable.length > 0 ? (
        <div className="p-2">
          <Banner tone="warn">
            {unreadable.length} file(s) could not be read and were left out:{" "}
            {unreadable.join(", ")}
          </Banner>
        </div>
      ) : null}

      {sensitiveFiles.length > 0 ? (
        <div className="p-2">
          <Banner tone="error">
            This prompt includes {sensitiveFiles.length} file(s) that likely
            contain secrets: {sensitiveFiles.join(", ")}. Deselect them in the
            project tree if they should not be sent to the AI.
          </Banner>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {prompt === "" ? (
          <p className="p-3 text-xs text-slate-500">
            {customPrompt.trim() === ""
              ? "Generate a prompt to start. With a project open, only the files selected in the tree are included; with no project open, the prompt contains the output contract and your additional instructions alone."
              : 'No prompt generated. Type your instruction below, or click "Generate prompt" to include the selected files.'}
          </p>
        ) : (
          <Editor
            height="100%"
            language="markdown"
            theme="vs-dark"
            value={effectivePrompt}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              wordWrap: "on",
              scrollBeyondLastLine: false,
              fontSize: 12,
              automaticLayout: true,
            }}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[#2c3038] p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <label
            htmlFor="custom-prompt"
            className="block text-xs font-medium text-slate-400"
          >
            Input instruction
          </label>
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            onClick={() => void suggestFiles()}
            disabled={aiSuggesting || customPrompt.trim() === ""}
            title={
              aiSettings?.suggestMethod === "gitnexus-jev"
                ? "Search locally, then rank with Jev (TypeSafe key)"
                : aiSettings?.suggestMethod === "gitnexus-llm"
                  ? "Search locally, then rank with the selected chat provider"
                  : "Search locally with GitNexus + BM25 — no AI call"
            }
          >
            {aiSuggesting ? "Thinking…" : "✨ Suggest files"}
          </Button>
        </div>
        <textarea
          id="custom-prompt"
          value={customPrompt}
          onChange={(event) => setCustomPrompt(event.target.value)}
          placeholder="Describe the change you want, or use ✨ Suggest files to pick relevant files."
          spellCheck={false}
          rows={3}
          className="w-full resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 text-xs text-slate-200 outline-none focus:border-sky-600"
        />
        {aiSettings?.suggestMethod === "gitnexus-jev" &&
        !aiSettings.hasApiKey["typesafe"] ? (
          <p className="mt-1 text-[11px] text-slate-500">
            No TypeSafe key saved.{" "}
            <button
              type="button"
              className="text-sky-400 hover:text-sky-300"
              onClick={() => setEditorTab("settings")}
            >
              Open Settings
            </button>
          </p>
        ) : null}
        {aiLastSuggestion ? (
          <div className="mt-2">
            <Banner
              tone={
                aiLastSuggestion.hallucinated.length > 0 ? "warn" : "success"
              }
            >
              {aiLastSuggestion.paths.length} file(s) selected{" "}
              {aiLastSuggestion.method === "gitnexus-only" ? (
                <>
                  via local search (gitnexus-only, no AI call,{" "}
                  {(aiLastSuggestion.candidateCount ?? 0).toLocaleString()}{" "}
                  candidates)
                </>
              ) : aiLastSuggestion.method === "gitnexus-jev" ? (
                <>
                  via GitNexus recall + Jev precision (
                  {(aiLastSuggestion.jevIncluded?.length ?? 0).toLocaleString()}{" "}
                  included,{" "}
                  {(aiLastSuggestion.jevFlagged?.length ?? 0).toLocaleString()}{" "}
                  for review,{" "}
                  {(aiLastSuggestion.jevDropped?.length ?? 0).toLocaleString()}{" "}
                  dropped) — {aiLastSuggestion.model}
                </>
              ) : aiLastSuggestion.method === "gitnexus-llm" ? (
                <>
                  via GitNexus recall + {aiLastSuggestion.provider} ranking (
                  {(aiLastSuggestion.jevIncluded?.length ?? 0).toLocaleString()}{" "}
                  included,{" "}
                  {(aiLastSuggestion.jevFlagged?.length ?? 0).toLocaleString()}{" "}
                  for review,{" "}
                  {(aiLastSuggestion.jevDropped?.length ?? 0).toLocaleString()}{" "}
                  dropped) — {aiLastSuggestion.model}
                </>
              ) : (
                <>
                  via {aiLastSuggestion.provider}/{aiLastSuggestion.model}
                  {" (current: full map)"}
                </>
              )}{" "}
              — {aiLastSuggestion.mapTokens.toLocaleString()} map tokens,{" "}
              {aiLastSuggestion.durationMs.toLocaleString()} ms
              {aiLastSuggestion.gitnexusMissing
                ? " — gitnexus CLI not found, BM25 search only"
                : ""}
              {aiLastSuggestion.hallucinated.length > 0
                ? ` — dropped ${aiLastSuggestion.hallucinated.length} nonexistent path(s)`
                : ""}
            </Banner>
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t border-[#2c3038] px-3 py-1.5 text-xs text-slate-500">
        <span>{promptFileCount} file(s)</span>
        <span>~{displayTokens.toLocaleString()} prompt tokens</span>
        {mapTokenCount !== null ? (
          <span>~{mapTokenCount.toLocaleString()} map tokens</span>
        ) : null}
      </footer>
    </div>
  );
}

function EditorTab(): ReactElement {
  const editingPath = useAppStore((state) => state.editingPath);
  const editingContent = useAppStore((state) => state.editingContent);
  const editingLoading = useAppStore((state) => state.editingLoading);
  const setEditingContent = useAppStore((state) => state.setEditingContent);

  if (!editingPath) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-sm text-xs text-slate-500">
          Double-click a file in the project tree to open it here for reading
          and editing. Saving writes it back to disk.
        </p>
      </div>
    );
  }

  if (editingLoading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <p className="text-xs text-slate-500">Loading {editingPath}…</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1">
      <Editor
        height="100%"
        // Monaco infers the language from the file extension when handed a
        // path, so `languageForPath` does not need a duplicate table here.
        path={editingPath}
        theme="vs-dark"
        value={editingContent}
        onChange={(value) => setEditingContent(value ?? "")}
        options={{
          readOnly: false,
          minimap: { enabled: false },
          wordWrap: "on",
          scrollBeyondLastLine: false,
          fontSize: 12,
          automaticLayout: true,
        }}
      />
    </div>
  );
}

export function PromptDashboard(): ReactElement {
  const tree = useAppStore((state) => state.tree);
  const prompt = useAppStore((state) => state.prompt);
  const building = useAppStore((state) => state.building);
  const buildPrompt = useAppStore((state) => state.buildPrompt);
  const clearPrompt = useAppStore((state) => state.clearPrompt);
  const copyPrompt = useAppStore((state) => state.copyPrompt);
  const savePrompt = useAppStore((state) => state.savePrompt);

  const editorTab = useAppStore((state) => state.editorTab);
  const setEditorTab = useAppStore((state) => state.setEditorTab);
  const editingPath = useAppStore((state) => state.editingPath);
  const editingContent = useAppStore((state) => state.editingContent);
  const editingOriginal = useAppStore((state) => state.editingOriginal);
  const saving = useAppStore((state) => state.saving);
  const saveEditingFile = useAppStore((state) => state.saveEditingFile);
  const revertEditingFile = useAppStore((state) => state.revertEditingFile);
  const closeEditor = useAppStore((state) => state.closeEditor);

  const gitStatus = useAppStore((state) => state.gitStatus);

  const counts = useMemo(
    () => (tree ? countFiles(tree) : { selected: 0, total: 0 }),
    [tree],
  );
  const editingDirty = editingContent !== editingOriginal;

  // A count badge for the Source Control tab: staged + unstaged + untracked.
  // `undefined` means not yet loaded; `null` means not a repo — both render
  // as no badge, which is the right signal for either state.
  const gitChangeCount =
    gitStatus && typeof gitStatus === "object"
      ? gitStatus.staged.length +
        gitStatus.unstaged.length +
        gitStatus.untracked.length +
        gitStatus.conflicted.length
      : 0;

  const headerActions: ReactNode =
    editorTab === "prompt" ? (
      <>
        <span className="text-xs text-slate-500">
          {counts.selected} / {counts.total} selected
        </span>
        <Button
          variant="primary"
          onClick={() => void buildPrompt()}
          disabled={building}
        >
          {building ? "Building…" : "Generate prompt"}
        </Button>
        {/* Clear, Copy, and Save all use the same default variant so the row
            reads as one group of secondary actions next to the primary
            Generate button. */}
        <Button
          onClick={clearPrompt}
          disabled={prompt === ""}
          title="Clear the generated prompt. The input instruction is kept."
        >
          Clear
        </Button>
        <Button
          onClick={() => void copyPrompt()}
          disabled={prompt === ""}
          title="Copy the prompt to the clipboard, with the input instruction inserted."
        >
          Copy
        </Button>
        <Button
          onClick={() => void savePrompt()}
          disabled={prompt === ""}
          title="Save the prompt to a file on disk."
        >
          Save
        </Button>
      </>
    ) : editorTab === "editor" ? (
      <>
        {editingPath ? (
          <span
            className="max-w-[240px] truncate font-mono text-xs text-slate-400"
            title={editingPath}
          >
            {editingPath}
            {editingDirty ? (
              <span className="ml-1 text-amber-400">•</span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-slate-500">No file open</span>
        )}
        <Button
          onClick={revertEditingFile}
          disabled={!editingPath || !editingDirty || saving}
          title="Discard unsaved changes and reload the file from disk"
        >
          Revert
        </Button>
        <Button
          variant="primary"
          onClick={() => void saveEditingFile()}
          disabled={!editingPath || !editingDirty || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={closeEditor} disabled={!editingPath}>
          Close
        </Button>
      </>
    ) : // Source Control tab has its own action bar inside the panel — the
    // header shows nothing here, keeping the panel's own controls as the
    // single source of truth for Git operations.
    null;

  return (
    <Panel
      title="Workspace"
      className="min-w-0 flex-1 border-r"
      actions={headerActions}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-stretch border-b border-[#2c3038]">
          <TabButton
            active={editorTab === "prompt"}
            onClick={() => setEditorTab("prompt")}
          >
            Prompt
          </TabButton>
          <TabButton
            active={editorTab === "editor"}
            onClick={() => setEditorTab("editor")}
          >
            Editor
            {editingDirty ? (
              <span className="ml-1 text-amber-400">•</span>
            ) : null}
          </TabButton>
          <TabButton
            active={editorTab === "source"}
            onClick={() => setEditorTab("source")}
          >
            Source Control
            {gitChangeCount > 0 ? (
              <span className="ml-1 rounded bg-[#2a2f38] px-1.5 text-[10px] text-slate-300">
                {gitChangeCount}
              </span>
            ) : null}
          </TabButton>
          <TabButton
            active={editorTab === "settings"}
            onClick={() => setEditorTab("settings")}
          >
            Settings
          </TabButton>
        </div>

        {editorTab === "prompt" ? (
          <PromptTab />
        ) : editorTab === "editor" ? (
          <EditorTab />
        ) : editorTab === "settings" ? (
          <AiSettingsPanel />
        ) : (
          <SourceControl />
        )}
      </div>
    </Panel>
  );
}
