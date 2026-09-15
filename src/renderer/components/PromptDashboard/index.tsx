import { useMemo } from 'react'
import type { ReactElement } from 'react'
import Editor from '@monaco-editor/react'
import { useAppStore } from '../../stores/app-store'
import { countFiles } from '../../lib/tree'
import { Banner, Button, Panel } from '../../lib/ui'

const TOKEN_WARNING_THRESHOLD = 100_000

export function PromptDashboard(): ReactElement {
  const tree = useAppStore((state) => state.tree)
  const prompt = useAppStore((state) => state.prompt)
  const tokenCount = useAppStore((state) => state.tokenCount)
  const promptFileCount = useAppStore((state) => state.promptFileCount)
  const unreadable = useAppStore((state) => state.unreadable)
  const building = useAppStore((state) => state.building)
  const buildPrompt = useAppStore((state) => state.buildPrompt)
  const copyPrompt = useAppStore((state) => state.copyPrompt)
  const savePrompt = useAppStore((state) => state.savePrompt)

  const counts = useMemo(() => (tree ? countFiles(tree) : { selected: 0, total: 0 }), [tree])

  return (
    <Panel
      title="Prompt"
      className="min-w-0 flex-1 border-r"
      actions={
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
      }
    >
      <div className="flex h-full flex-col">
        {tokenCount > TOKEN_WARNING_THRESHOLD ? (
          <div className="p-2">
            <Banner tone="warn">
              Prompt is ~{tokenCount.toLocaleString()} tokens, above the{' '}
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

        <div className="min-h-0 flex-1">
          {prompt === '' ? (
            <p className="p-3 text-xs text-slate-500">
              Select files in the tree, then generate the prompt.
            </p>
          ) : (
            <Editor
              height="100%"
              language="markdown"
              theme="vs-dark"
              value={prompt}
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

        <footer className="flex shrink-0 items-center gap-4 border-t border-[#2c3038] px-3 py-1.5 text-xs text-slate-500">
          <span>{promptFileCount} file(s)</span>
          <span>~{tokenCount.toLocaleString()} tokens</span>
        </footer>
      </div>
    </Panel>
  )
}
