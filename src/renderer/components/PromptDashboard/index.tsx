import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import { useAppStore } from '../../stores/app-store'
import { countFiles } from '../../lib/tree'
import { insertCustomPrompt } from '../../lib/prompt'
import { Banner, Button, Panel } from '../../lib/ui'

const TOKEN_WARNING_THRESHOLD = 100_000

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-xs font-medium transition ${
        active
          ? 'border-sky-500 text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  )
}

function PromptTab(): ReactElement {
  const prompt = useAppStore((state) => state.prompt)
  const tokenCount = useAppStore((state) => state.tokenCount)
  const promptFileCount = useAppStore((state) => state.promptFileCount)
  const unreadable = useAppStore((state) => state.unreadable)
  const sensitiveFiles = useAppStore((state) => state.sensitiveFiles)
  const customPrompt = useAppStore((state) => state.customPrompt)
  const setCustomPrompt = useAppStore((state) => state.setCustomPrompt)

  // What the user actually sees and copies: the built base prompt with the
  // current additional instructions appended. Recomputing here (rather than at
  // build time) means an edit to the textarea lands immediately, without
  // re-reading files.
  const effectivePrompt = useMemo(
    () => insertCustomPrompt(prompt, customPrompt),
    [prompt, customPrompt],
  )

  // Token count of the effective prompt. When there is no custom section the
  // build-time count is exact; when there is one, recompute via IPC —
  // debounced so typing does not flood the main process.
  const [customTokens, setCustomTokens] = useState<number | null>(null)
  useEffect(() => {
    if (prompt === '' || customPrompt.trim() === '') {
      setCustomTokens(null)
      return
    }
    const timer = setTimeout(() => {
      void window.LARPGent.countTokens(effectivePrompt).then(setCustomTokens)
    }, 300)
    return () => clearTimeout(timer)
  }, [effectivePrompt, customPrompt, prompt])

  const displayTokens = customTokens ?? tokenCount

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {displayTokens > TOKEN_WARNING_THRESHOLD ? (
        <div className="p-2">
          <Banner tone="warn">
            Prompt is ~{displayTokens.toLocaleString()} tokens, above the{' '}
            {TOKEN_WARNING_THRESHOLD.toLocaleString()} token guidance. Most models will still
            accept it, but expect slower or truncated responses.
          </Banner>
        </div>
      ) : null}

      {unreadable.length > 0 ? (
        <div className="p-2">
          <Banner tone="warn">
            {unreadable.length} file(s) could not be read and were left out:{' '}
            {unreadable.join(', ')}
          </Banner>
        </div>
      ) : null}

      {sensitiveFiles.length > 0 ? (
        <div className="p-2">
          <Banner tone="error">
            This prompt includes {sensitiveFiles.length} file(s) that likely
            contain secrets: {sensitiveFiles.join(', ')}. Deselect them in the
            project tree if they should not be sent to the AI.
          </Banner>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {prompt === '' ? (
          <p className="p-3 text-xs text-slate-500">
            Generate a prompt to start. With a project open, only the files
            selected in the tree are included; with no project open, the
            prompt contains the output contract and your additional
            instructions alone.
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
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              fontSize: 12,
              automaticLayout: true,
            }}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[#2c3038] p-2">
        <label
          htmlFor="custom-prompt"
          className="mb-1 block text-xs font-medium text-slate-400"
        >
          Additional instructions
        </label>
        <textarea
          id="custom-prompt"
          value={customPrompt}
          onChange={(event) => setCustomPrompt(event.target.value)}
          placeholder="Extra context or requirements to include with the selected files (e.g. target framework, coding conventions, constraints). Appended to the end of the full prompt when you copy or save."
          spellCheck={false}
          rows={3}
          className="w-full resize-y rounded border border-[#2c3038] bg-[#12141a] p-2 text-xs text-slate-200 outline-none focus:border-sky-600"
        />
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t border-[#2c3038] px-3 py-1.5 text-xs text-slate-500">
        <span>{promptFileCount} file(s)</span>
        <span>~{displayTokens.toLocaleString()} tokens</span>
      </footer>
    </div>
  )
}

function EditorTab(): ReactElement {
  const editingPath = useAppStore((state) => state.editingPath)
  const editingContent = useAppStore((state) => state.editingContent)
  const editingLoading = useAppStore((state) => state.editingLoading)
  const setEditingContent = useAppStore((state) => state.setEditingContent)

  if (!editingPath) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-sm text-xs text-slate-500">
          Double-click a file in the project tree to open it here for reading
          and editing. Saving writes it back to disk with a .bak backup of any
          prior version.
        </p>
      </div>
    )
  }

  if (editingLoading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <p className="text-xs text-slate-500">Loading {editingPath}…</p>
      </div>
    )
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
        onChange={(value) => setEditingContent(value ?? '')}
        options={{
          readOnly: false,
          minimap: { enabled: false },
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          fontSize: 12,
          automaticLayout: true,
        }}
      />
    </div>
  )
}

export function PromptDashboard(): ReactElement {
  const tree = useAppStore((state) => state.tree)
  const prompt = useAppStore((state) => state.prompt)
  const building = useAppStore((state) => state.building)
  const buildPrompt = useAppStore((state) => state.buildPrompt)
  const copyPrompt = useAppStore((state) => state.copyPrompt)
  const savePrompt = useAppStore((state) => state.savePrompt)

  const editorTab = useAppStore((state) => state.editorTab)
  const setEditorTab = useAppStore((state) => state.setEditorTab)
  const editingPath = useAppStore((state) => state.editingPath)
  const editingContent = useAppStore((state) => state.editingContent)
  const editingOriginal = useAppStore((state) => state.editingOriginal)
  const saving = useAppStore((state) => state.saving)
  const saveEditingFile = useAppStore((state) => state.saveEditingFile)
  const revertEditingFile = useAppStore((state) => state.revertEditingFile)
  const closeEditor = useAppStore((state) => state.closeEditor)

  const counts = useMemo(
    () => (tree ? countFiles(tree) : { selected: 0, total: 0 }),
    [tree],
  )
  const editingDirty = editingContent !== editingOriginal

  const headerActions: ReactNode =
    editorTab === 'prompt' ? (
      <>
        <span className="text-xs text-slate-500">
          {counts.selected} / {counts.total} selected
        </span>
        <Button variant="primary" onClick={() => void buildPrompt()} disabled={building}>
          {building ? 'Building…' : 'Generate prompt'}
        </Button>
        <Button onClick={() => void copyPrompt()} disabled={prompt === ''}>
          Copy
        </Button>
        <Button onClick={() => void savePrompt()} disabled={prompt === ''}>
          Save
        </Button>
      </>
    ) : (
      <>
        {editingPath ? (
          <span
            className="max-w-[240px] truncate font-mono text-xs text-slate-400"
            title={editingPath}
          >
            {editingPath}
            {editingDirty ? <span className="ml-1 text-amber-400">•</span> : null}
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
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          onClick={closeEditor}
          disabled={!editingPath}
        >
          Close
        </Button>
      </>
    )

  return (
    <Panel
      title="Workspace"
      className="min-w-0 flex-1 border-r"
      actions={headerActions}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-stretch border-b border-[#2c3038]">
          <TabButton
            active={editorTab === 'prompt'}
            onClick={() => setEditorTab('prompt')}
          >
            Prompt
          </TabButton>
          <TabButton
            active={editorTab === 'editor'}
            onClick={() => setEditorTab('editor')}
          >
            Editor
            {editingDirty ? <span className="ml-1 text-amber-400">•</span> : null}
          </TabButton>
        </div>

        {editorTab === 'prompt' ? <PromptTab /> : <EditorTab />}
      </div>
    </Panel>
  )
}
