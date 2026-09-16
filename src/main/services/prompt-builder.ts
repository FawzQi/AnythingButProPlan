import path from 'node:path'
import Handlebars from 'handlebars'
import { countTokens } from 'gpt-tokenizer'
import type { PromptBuildResult } from '@shared/types'
import templateSource from '../../../resources/prompt-templates/default.hbs?raw'
import { readTextFile } from './fs-service'

/** Fence language derived from the file extension; falls back to `text`. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.php': 'php',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sh': 'bash',
  '.sql': 'sql',
  '.xml': 'xml',
  '.hbs': 'handlebars',
}

export function languageForPath(filePath: string): string {
  return EXTENSION_LANGUAGES[path.extname(filePath).toLowerCase()] ?? 'text'
}

interface TreeNode {
  name: string
  children: Map<string, TreeNode>
}

/**
 * Render a directory listing for the selected file paths only.
 * Paths are POSIX-relative and pre-sorted by the caller's file tree.
 */
export function buildTreeLines(filePaths: string[]): string {
  const root: TreeNode = { name: '', children: new Map() }

  for (const filePath of [...filePaths].sort()) {
    const segments = filePath.split('/').filter(Boolean)
    let node = root
    for (const segment of segments) {
      let child = node.children.get(segment)
      if (!child) {
        child = { name: segment, children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
  }

  const lines: string[] = []
  const render = (node: TreeNode, prefix: string): void => {
    const entries = [...node.children.values()]
    entries.forEach((child, index) => {
      const last = index === entries.length - 1
      lines.push(`${prefix}${last ? '└── ' : '├── '}${child.name}`)
      render(child, `${prefix}${last ? '    ' : '│   '}`)
    })
  }
  render(root, '')
  return lines.join('\n')
}

const template = Handlebars.compile(templateSource, { noEscape: true })

export interface PromptFile {
  path: string
  language: string
  content: string
}

export function renderPrompt(tree: string, files: PromptFile[]): string {
  return template({ tree, files })
}

/**
 * Read the selected files and assemble the base prompt (files + the output
 * contract). The user's additional instructions are *not* baked in here — they
 * are inserted in the renderer at display/copy/save time so an edit to that
 * box takes effect without a rebuild.
 */
export async function buildPrompt(
  projectRoot: string,
  filePaths: string[],
): Promise<PromptBuildResult> {
  const files: PromptFile[] = []
  const unreadable: string[] = []

  for (const filePath of filePaths) {
    try {
      const content = await readTextFile(projectRoot, filePath)
      files.push({ path: filePath, language: languageForPath(filePath), content })
    } catch {
      unreadable.push(filePath)
    }
  }

  const prompt = renderPrompt(
    buildTreeLines(files.map((file) => file.path)),
    files,
  )

  return {
    prompt,
    tokenCount: countTokens(prompt),
    fileCount: files.length,
    unreadable,
  }
}
