import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'

// Serve Monaco from the bundle instead of the default CDN loader: the renderer
// runs under a strict CSP and must work offline.
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

loader.config({ monaco })
