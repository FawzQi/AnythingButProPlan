CLAUDE.md
This file provides guidance to Claude Code when working on this repository.

Project Overview
LARPGent is a cross-platform desktop application (Windows + Ubuntu Linux) that bridges two workflows:

Codebase → Prompt: Browse a project directory, select files/folders via checkboxes, and generate a structured prompt that can be copied or saved to a file. (Similar to the code2prompt VS Code extension.)

AI Response → Code: Paste an AI chat response back into the app, parse it into individual file changes, preview diffs, and safely write the code to disk.

The second feature is the core engineering challenge. LLM output is non-deterministic, so this app uses a layered strategy: prompt engineering to reduce variance, resilient parsing to handle drift, and mandatory user confirmation before any write.

Tech Stack
Runtime: Electron (main process = Node.js, renderer = Chromium)

Language: TypeScript (strict mode, no any without justification)

UI Framework: React 18 + Vite

Styling: Tailwind CSS + shadcn/ui components

State: Zustand (lightweight, no Redux boilerplate)

Code Preview: Monaco Editor (for prompt preview) + react-diff-viewer-continued (for diffs)

File Tree: Custom virtualized tree using react-window

Packaging: electron-builder (NSIS for Windows, AppImage + .deb for Ubuntu)

Testing: Vitest (unit) + Playwright (E2E)

Key Dependencies
Purpose Package
Gitignore filtering ignore
Markdown parsing marked (fallback parser)
XML parsing fast-xml-parser (primary parser)
Token counting gpt-tokenizer
Diff generation diff
Path sanitization sanitize-filename + custom traversal guard
Clipboard Electron's built-in clipboard module
Architecture
text
┌─────────────────────────────────────────────────────────┐
│ Renderer Process (React) │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│ │ File Tree │ │ Prompt │ │ AI Response │ │
│ │ (checkboxes) │ │ Dashboard │ │ Parser & │ │
│ │ │ │ (preview) │ │ Apply Panel │ │
│ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ │
│ └─────────────────┼─────────────────┘ │
│ │ contextBridge (IPC) │
├───────────────────────────┼─────────────────────────────┤
│ Main Process (Node.js) ▼ │
│ ┌──────────────────────────────────────────────────┐ │
│ │ fs-service.ts • scan, read, write, backup │ │
│ │ prompt-builder.ts • tree → markdown prompt │ │
│ │ response-parser.ts • XML → markdown fallback │ │
│ │ apply-engine.ts • diff, confirm, write │ │
│ └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
Security Rules (Non-Negotiable)
nodeIntegration: false, contextIsolation: true in all BrowserWindows.

All filesystem access goes through contextBridge-exposed IPC handlers. The renderer never touches fs directly.

Every file path from an AI response MUST be validated before any write. Reject paths containing .. that resolve outside the project root. Reject absolute paths outside the project root.

Never write a file without first creating a .bak copy of the existing version.

Project Structure
text
LARPGents/
├── src/
│ ├── main/ # Electron main process
│ │ ├── index.ts # App entry, window creation
│ │ ├── ipc.ts # IPC handler registration
│ │ └── services/
│ │ ├── fs-service.ts
│ │ ├── prompt-builder.ts
│ │ ├── response-parser/
│ │ │ ├── index.ts # Parser cascade orchestrator
│ │ │ ├── xml-parser.ts
│ │ │ ├── markdown-parser.ts
│ │ │ ├── path-heuristics.ts
│ │ │ └── types.ts
│ │ └── apply-engine.ts
│ ├── preload/
│ │ └── index.ts # contextBridge API
│ ├── renderer/
│ │ ├── App.tsx
│ │ ├── components/
│ │ │ ├── FileTree/
│ │ │ ├── PromptDashboard/
│ │ │ ├── ResponsePanel/
│ │ │ └── DiffViewer/
│ │ ├── stores/
│ │ └── lib/
│ └── shared/
│ └── types.ts # Shared between main & renderer
├── tests/
│ ├── unit/
│ └── e2e/
├── resources/
│ └── prompt-templates/ # Handlebars templates
└── package.json
Feature 1: Codebase → Prompt
File Tree Requirements
Recursively scan a user-selected directory.

Respect .gitignore via the ignore package. Always skip: node_modules, .git, dist, build, **pycache**, venv, .venv, target, bin, obj, .next, .cache.

Skip binary files (detect via extension list + first-1024-bytes null-byte check).

Checkbox state must cascade: toggling a directory selects/deselects all descendants.

Tree must be virtualized—assume the user may open a monorepo with 50,000+ files.

Prompt Template Contract
Default template lives in resources/prompt-templates/default.hbs. It MUST produce output matching this exact structure:

markdown

# Codebase Context

## Project Structure

```
<tree of selected files only>
```

## Files

<file path="src/app.ts">
```typescript
<full file contents>
```
</file>

<file path="src/utils/helper.ts">
```typescript
<full file contents>
```
</file>
Why XML tags around each file? They create a deterministic envelope for the return trip. See "Feature 2" below.

Token Counting
Always display an estimated token count next to the prompt preview. Use gpt-tokenizer. If the prompt exceeds 100,000 tokens, show a warning banner but allow the user to proceed.

Feature 2: Chat Result → Code (THE CORE FEATURE)
This is the most important part of the app. Treat every design decision here with the assumption that the AI WILL deviate from the expected format sometimes. The system must degrade gracefully, never lose data, and never write without confirmation.

The Output Contract (What We Ask the AI to Produce)
Our prompt template instructs the AI to respond with only this structure:

xml
<file path="relative/path/to/file.ext">

````language
full file contents
</file><file path="another/file.ext"> ```language full file contents ``` </file> ```
No conversational text before, between, or after the <file> blocks. This is enforced via the prompt itself.

The Parser Cascade (What We Actually Accept)
The parser in services/response-parser/index.ts MUST attempt these strategies in order, returning the first one that yields at least one file:

Strategy 1: Strict XML Envelope
Use fast-xml-parser to extract <file path="..."> blocks.

Strip any surrounding markdown fences inside the block.

If at least one <file> is found with a valid path attribute → return immediately.

Strategy 2: Markdown Fenced Code Blocks
Scan for ``` fences using a line-based state machine (NOT a full markdown parser—we need the raw content and fence positions).

For each block, extract:

language (from the fence info string)

content (raw text between fences)

precedingText (the 3 lines before the opening fence)

For each block, resolve the path via path-heuristics.ts (see below).

Strategy 3: User-Assisted Mapping
If strategies 1 and 2 both fail to produce a complete mapping (some blocks have no resolvable path), surface ALL extracted code blocks to the user in the UI.

Show the block content in a preview pane.

Let the user pick a target path from the file tree, or type a new path.

Never throw an error on parse failure—always fall through to the next strategy, ending with user-assisted mapping.

Path Heuristics (Order of Precedence)
For each code block, resolve its target path using these rules in order:

Explicit path attribute (XML parser only).

First-line comment: match ^\s*(?://|#|<!--)\s*(?:File:)?\s*(.+?\.\w+)\s*(?:-->)?\s*$ on the first non-empty line.

Preceding text: search the 3 lines before the fence for a backtick-wrapped or bold path: `src/app.ts` or **src/app.ts**.

Language + single-file hint: if the preceding text mentions "the file" or "this file" and the language maps to a common extension, suggest a default but mark as ambiguous.

Ambiguous: return { path: null, ambiguous: true } and require user input in the UI.

Diff Preview (Mandatory)
Before ANY file write, the UI MUST show:

A table listing every detected file with columns: Path, Action (create / overwrite), Block language, Path source (which heuristic resolved it).

Clicking a row opens a side-by-side diff using react-diff-viewer-continued:

For new files: full content as green +.

For existing files: unified diff between current disk content and proposed content.

A per-file checkbox to include/exclude the file from the apply operation.

Apply Engine Rules
In services/apply-engine.ts:

Validate every path: path.resolve(projectRoot, relativePath) MUST start with projectRoot. Reject otherwise with a clear error.

Backup before overwrite: write <file>.bak in the same directory if the file exists. If a .bak already exists, append a timestamp: <file>.bak.20250914T120000.

Atomic writes: write to <file>.tmp then fs.rename() to the target. Prevents partial writes on crash.

Report per-file results: return an array of { path, status: 'created' | 'overwritten' | 'skipped' | 'failed', error?: string }.

Never roll back automatically on partial failure. Report the failure and let the user decide.

What NOT to Do
❌ Do NOT trust line numbers in AI output. LLMs cannot count lines. If a future feature adds diff/SEARCH-REPLACE support, use text anchors, not line numbers.

❌ Do NOT auto-apply changes without showing the diff. This is the single rule that prevents catastrophe.

❌ Do NOT silently skip a block whose path cannot be resolved. Surface it to the user.

❌ Do NOT normalize or reformat the AI's code content. Write it verbatim.

Future: Diff-Based Edits (v2, Do Not Build Yet)
When adding diff support later, use SEARCH/REPLACE blocks with surrounding context, modeled after Aider:

text
<<<<<<< SEARCH
<exact text to find>
=======
<replacement text>
>>>>>>> REPLACE
Implement fuzzy matching as a fallback (whitespace-insensitive, then line-anchor-based). Never use line numbers. This is documented here so future work stays aligned.

Shared Type Definitions
All IPC-exposed types live in src/shared/types.ts. Define these up front:

typescript
export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  selected: boolean;
  expanded: boolean;
}

export interface ParsedFile {
  path: string | null;          // null = ambiguous, needs user input
  content: string;              // raw code, unmodified
  language: string | null;
  pathSource: 'xml' | 'first-line-comment' | 'preceding-text' | 'language-hint' | 'user';
  ambiguous: boolean;
  rawBlock: string;             // original text for debugging
}

export interface ParseResult {
  files: ParsedFile[];
  strategy: 'xml' | 'markdown' | 'user-assisted';
  warnings: string[];
}

export interface ApplyResult {
  path: string;
  status: 'created' | 'overwritten' | 'skipped' | 'failed';
  error?: string;
}
Development Conventions
TypeScript strict mode is required. No any unless accompanied by a comment explaining why.

All IPC channels are declared in src/shared/ipc-channels.ts as a const enum. Never use string literals for channel names.

All filesystem operations live in services/fs-service.ts. No fs imports elsewhere in src/main/.

Parser code is pure: response-parser/ must have zero side effects and zero dependencies on Electron. It should be testable as a plain function parseResponse(raw: string): ParseResult.

Commit small, commit often. Each parser strategy should be a separate commit with its own tests.

Testing Strategy
Unit Tests (Vitest)
Focus 80% of test effort on the parser. Create a tests/fixtures/responses/ directory with real LLM outputs, both well-formed and malformed:

clean-xml.txt — perfect XML envelope

markdown-with-paths.txt — no XML, but paths in comments

markdown-no-paths.txt — code blocks with no path hints

mixed-conversational.txt — code blocks interspersed with "Sure, here's the fix..."

nested-fences.txt — markdown inside a code block (```md containing ```)

missing-close-tag.txt — malformed XML that should fall through to markdown

windows-paths.txt — paths using \ separators

For each fixture, assert the exact ParseResult.

Integration Tests
Round-trip test: build a prompt from a fixture directory, feed it to a mock AI that echoes back the XML envelope, parse it, and assert the parsed files match the originals byte-for-byte.

Apply engine: test backup creation, atomic write, path traversal rejection.

E2E (Playwright)
Open a fixture project → select files → copy prompt → verify clipboard content.

Paste a fixture AI response → verify diff preview renders → click Apply → verify files on disk.

Cross-Platform Notes
Use path.posix normalization internally; convert with path.sep only at the fs boundary.

Test path handling on both Windows (\) and Linux (/) separators—fixtures include both.

electron-builder config in package.json must include targets: nsis (Windows), AppImage + deb (Linux).

Line endings: preserve whatever the AI produced. Do NOT normalize CRLF ↔ LF.

Build Commands
bash
npm run dev          # Vite dev server + Electron hot reload
npm run build        # Production build
npm run test         # Vitest unit tests
npm run test:e2e     # Playwright E2E
npm run package:win  # Windows installer
npm run package:linux # AppImage + .deb
npm run lint         # ESLint + Prettier check
When in Doubt
The two rules that matter most:

Never write to disk without showing the user a diff first.

When the parser fails, degrade gracefully to user-assisted mapping—never throw away code the AI produced.

Everything else is negotiable. These two are not.
````
