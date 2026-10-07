# AnythingButProPlan (WIP)

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Electron](https://img.shields.io/badge/Electron-44.3-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7.0-646CFF?logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-5.0-6E9F18?logo=vitest&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-4.3-38B2AC?logo=tailwind-css&logoColor=white)

**A local-first, privacy-respecting desktop bridge between your codebase, research documents, and AI models.**

*Turn projects into precision prompts, parse AI responses back to disk, and interrogate research papers with grounded citations — without expensive monthly SaaS "Pro" subscriptions.*

</div>

---

## Table of Contents

- [Overview](#overview)
- [Core Philosophy](#core-philosophy)
- [Key Features](#key-features)
  - [1. Coding Mode](#1-coding-mode)
  - [2. Research Mode](#2-research-mode)
- [Supported AI Providers](#supported-ai-providers)
- [System Requirements](#system-requirements)
- [Installation](#installation)
- [Running the Application](#running-the-application)
- [How to Use](#how-to-use)
  - [Initial Setup](#initial-setup)
  - [Coding Mode Workflow](#coding-mode-workflow)
  - [Research Mode Workflow](#research-mode-workflow)
- [Architecture & Codebase Organization](#architecture--codebase-organization)
- [Security & Privacy Guarantees](#security--privacy-guarantees)
- [Contributing & Testing](#contributing--testing)
- [License](#license)

---

## Overview

**AnythingButProPlan** is a desktop application engineered with Electron, React, and TypeScript. It replaces the friction of copy-pasting code into web chat windows or paying for closed-source IDE subscriptions with a transparent, local-first workflow:

1. **Context Extraction**: Assemble exact codebase or research document trees into minimal, token-optimized prompts.
2. **Contract Enforcement**: Enforce structured output formats (`SEARCH/REPLACE` blocks, full-file markdown fences, file deletion directives).
3. **Deterministic Application**: Parse AI responses, inspect side-by-side visual diffs in Monaco Editor, and safely apply changes directly to disk.

---

## Core Philosophy

- **Local-First & Offline-Ready**: Your files stay on your machine. There are no proprietary backend servers, no analytics, and zero telemetry.
- **Pay-As-You-Go / BYOK**: Bring your own API keys (OpenRouter, DeepSeek, Groq, Google Gemini, OpenAI, Qwen) and pay pennies per million tokens rather than flat $20–$100/mo fees.
- **OS-Encrypted Credential Storage**: API keys are securely encrypted at rest using OS-level secure storage (Electron `safeStorage` via GNOME Keyring / KWallet on Linux, Keychain on macOS, DPAPI on Windows) and never leak to the renderer.
- **Defensive Filesystem Safety**: Strict path traversal guards (`resolveWithinRoot`) reject null bytes, directory escaping (`..`), and unportable file names. Atomic temp-file-and-rename writes prevent corrupting your source files.

---

## Key Features

### 1. Coding Mode

- **Virtualized File Explorer**: High-performance tree view (`react-window`) with real-time `.gitignore` filtering and sensitive file warnings (e.g. `.env`, `.pem`, secrets).
- **Zero-AST Native Prompt Builder**: Packages selected source files and directory structure into clean markdown contexts with exact language tagging.
- **AI File Suggestion & GitNexus Integration**:
  - Semantic file recommendation using BM25 token matching.
  - Optional graph-based symbol dependency and blast radius analysis via GitNexus.
- **Multi-Strategy Response Parser**:
  - Automatically parses unified markdown fences, `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` patch blocks, and `Delete: <path>` directives.
  - Strips trailing explanatory prose and conversational model text.
- **Monaco Diff Viewer**: Side-by-side visual inspection of original vs. proposed file changes before applying.
- **Safe Apply Engine**: Atomically writes confirmed changes, deletes designated files, and skips identical content to maintain modification timestamps.
- **Integrated Git Tools**: Stage, discard, commit, and inspect status and branch details directly from the UI.

### 2. Research Mode

- **Document Ingestion**: Scans `docs/` (or the project root) for PDFs, Markdown, and plain text papers.
- **Markdown Conversion**:
  - **Auto Engine (Docling)**: Layout-aware GPU/CPU extraction powered by **Docling**. Reconstructs reading order, tables, multi-column paper layouts, and extracts figures to image files.
  - **Fast Engine (pdftext / pypdfium2)**: Instantaneous CPU extraction in seconds without downloading heavy deep learning weights.
- **Multimodal Figure Analysis**: Optional vision pass (DeepSeek, Qwen-VL, Gemini 2.5, GPT-4o) describing figures and diagrams inline.
- **Heading-Aware Semantic Chunking**: 300-token chunks with 50-token overlap, preserving heading hierarchies (`"3 Methodology > 3.2 Data Collection"`).
- **RAG Retrieval & Grounded Prompts**:
  - Vector similarity search powered by Google `text-embedding-004` (768-dim) with optional LLM reranking.
  - Assembles prompts with paper abstracts as preambles and verifiable verbatim citations (`### Excerpt N — paper.pdf, "Section"`).

---

## Supported AI Providers

| Provider | Chat Completion | Vision Analysis | Embeddings | Notes |
|---|---|---|---|---|
| **Google Gemini** | Yes (`gemini-2.5-flash`, `gemini-2.5-pro`) | Yes | Yes (`text-embedding-004`) | Generous free tier; default embedding model |
| **DeepSeek** | Yes (`deepseek-chat`, `deepseek-reasoner`) | Yes | No | Reasoning model token budget auto-scaled |
| **OpenRouter** | Yes (all catalog models) | Yes (vision models) | No | Unified aggregator with custom header attribution |
| **Groq** | Yes (ultra-low latency Llama models) | No | No | Blazing fast responses |
| **OpenAI** | Yes (`gpt-4o`, `o1`, `o3-mini`) | Yes | No | Standard OpenAI endpoints |
| **Qwen (DashScope)** | Yes | Yes (`qwen-vl`) | No | Strong multimodal performance |
| **TypeSafe (Jev)** | Typed decisions | No | No | Specialized typed-decision models |

---

## System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, Debian, Fedora, Arch), Windows 10/11, or macOS (11+).
- **Node.js**: v20.x, v22.x, or v24.x (v22+ LTS recommended).
- **npm**: v10.x or higher.
- **Git**: v2.30+ installed and accessible in `PATH`.
- **Python (Optional, for Research Mode PDF conversions)**:
  - Python 3.10+
  - **Auto Engine (Docling)**: Dedicated virtualenv with `docling`.
  - **Fast Engine**: System Python with `pdftext` (and `pypdfium2`).

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/AnythingButProPlan.git
cd AnythingButProPlan
```

### 2. Install Node Dependencies

```bash
npm install
```

### 3. Set up Python for Research Mode (Optional)

#### Option A: Fast Extractor (Seconds per paper, CPU only)

Install lightweight text extractors into your Python 3 environment:

```bash
pip install pdftext pypdfium2
```

#### Option B: Docling Engine (Accurate layout, tables, and figures)

Set up a dedicated virtual environment (default location: `/data/docling-env`):

```bash
# 1. Create the virtualenv
python3 -m venv /data/docling-env

# 2. Install Docling
/data/docling-env/bin/pip install docling
```

> **Environment Variables**:
> - `DOCLING_VENV`: Override virtualenv path if installed elsewhere (e.g. `export DOCLING_VENV=~/.venvs/docling`).
> - `DOCLING_DEVICE`: Set inference device (`cuda` by default, or `cpu` / `auto`).

---

## Running the Application

### Development Mode

Run with Vite hot-module replacement and Electron dev tools:

```bash
npm run dev
```

### Verification & Testing

```bash
# Type check all TypeScript files (main, preload, renderer, shared, tests)
npm run typecheck

# Run unit test suite (Vitest)
npm test

# Run unit tests in watch mode
npm run test:watch

# Run Playwright end-to-end tests
npm run test:e2e

# Run ESLint across entire repository
npm run lint
```

### Production Build & Packaging

```bash
# Compile production bundles
npm run build

# Preview production build locally
npm run start

# Build Linux installers (.AppImage and .deb)
npm run package:linux

# Build Windows installer (.exe via NSIS)
npm run package:win
```

Packaged binaries will be located in the `release/` directory.

---

## How to Use

### Initial Setup

1. Open **AnythingButProPlan**.
2. Click the **Settings** icon (gear in the top bar).
3. Select your provider (e.g., DeepSeek, Google Gemini, OpenRouter).
4. Enter your API key and choose your default model.
5. Click **Save Settings**. (Credentials are encrypted via `safeStorage`).

---

### Coding Mode Workflow

```
[Open Project] ──► [Select Files] ──► [Build Prompt / Run AI] ──► [Inspect Diff] ──► [Apply to Disk] ──► [Git Commit]
```

1. **Open Project**: Click **Open folder** and select your repository.
2. **Select Context**: Pick files from the file tree, or type instructions and click **Suggest files** (BM25 or GitNexus).
3. **Build Prompt**:
   - Inspect the generated prompt and live token count in the **Prompt Dashboard**.
   - Either click **Copy prompt** to paste into any external AI chat, or click **Run AI** for direct completion.
4. **Review & Diff**:
   - The AI response is parsed in the **Response Panel**.
   - Click any changed file to view the side-by-side Monaco diff viewer.
5. **Apply**:
   - Check the files you wish to modify.
   - Click **Apply selected**. Changes are written atomically.
   - Open the **Source Control** tab to stage and commit your changes.

---

### Research Mode Workflow

```
[Switch to Research] ──► [Place PDFs in docs/] ──► [Convert (Docling/Fast)] ──► [Build Index] ──► [Query / RAG Prompt]
```

1. **Switch Mode**: Select **Research** in the top navigation bar.
2. **Add Papers**: Place PDF or Markdown documents in `docs/` (or directly in your project root).
3. **Convert**:
   - Choose your engine: **Auto (Docling)** for tables & figures, or **Fast** for rapid text.
   - Click **Convert**.
4. **Build Vector Store**:
   - Go to the **Index** tab and click **Build index** to compute embeddings via Google `text-embedding-004`.
5. **Ask Questions**:
   - Type your question in the query input.
   - Select **RAG prompt** mode (which includes paper preambles and relevant excerpts).
   - Click **Build prompt** and send to your AI model to obtain grounded answers with exact section citations.

---

## Architecture & Codebase Organization

The codebase follows a modular domain-driven architecture with zero cyclic dependencies:

```
AnythingButProPlan/
├── resources/
│   └── python/                        # Helper scripts for PDF extraction
│       ├── docling_to_markdown.py     # Docling wrapper (base64 figure extractor)
│       └── pdf_to_markdown.py         # Fast extractor (pdftext + pypdfium2)
│
├── src/
│   ├── main/                          # Electron main process (Node.js runtime)
│   │   ├── index.ts                   # App lifecycle, window creation, security flags
│   │   ├── ipc/                       # Modular IPC registration
│   │   │   ├── handlers/              # Validated domain IPC handlers
│   │   │   │   ├── ai-handlers.ts
│   │   │   │   ├── dialog-handlers.ts
│   │   │   │   ├── file-handlers.ts
│   │   │   │   ├── git-handlers.ts
│   │   │   │   ├── prompt-handlers.ts
│   │   │   │   ├── research-handlers.ts
│   │   │   │   └── settings-handlers.ts
│   │   │   ├── register.ts            # Central handler registration
│   │   │   └── validation.ts          # Boundary input sanitization guards
│   │   │
│   │   └── services/                  # Business logic partitioned by domain
│   │       ├── ai/                    # LLM clients, vision analyzer, ranker, Jev
│   │       ├── coding/                # Prompt builder, response parser, apply engine
│   │       ├── core/                  # File system, settings encryption, cancellation
│   │       ├── git/                   # Git CLI service, GitNexus selector
│   │       ├── research/              # Scanner, converter, chunker, vector store
│   │       └── index.ts               # Clean services facade
│   │
│   ├── preload/                       # Narrow, secure ContextBridge API
│   │   └── index.ts
│   │
│   ├── renderer/                      # React 19 UI
│   │   ├── App.tsx                    # Root component with mode switching
│   │   ├── components/                # Presentation panels
│   │   │   ├── DocumentTree/          # Research document explorer & conversion UI
│   │   │   ├── FileTree/              # Coding mode virtualized file tree
│   │   │   ├── PromptDashboard/       # Prompt builder, token counter, settings
│   │   │   ├── ResearchDashboard/     # RAG queries and vector index management
│   │   │   ├── ResponsePanel/         # AI response parser & patch manager
│   │   │   ├── DiffViewer/            # Monaco side-by-side diff display
│   │   │   └── SourceControl/         # Git status, staging, and commit panel
│   │   │
│   │   └── stores/                    # State management (Zustand)
│   │       ├── app-store.ts           # Root store composition
│   │       ├── research-store.ts      # Dedicated research mode store
│   │       └── slices/                # Decomposed slices (project, prompt, response, editor, git, settings)
│   │
│   └── shared/                        # Shared TypeScript contracts
│       ├── config/                    # Central constants and timeout budgets
│       ├── types/                     # Domain type definitions
│       └── utils/                     # Canonical error handling utilities
│
└── tests/
    └── unit/                          # Unit tests mirroring domain structure (Vitest)
```

---

## Security & Privacy Guarantees

1. **Context Isolation**: Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The renderer cannot touch Node.js APIs or disk directly.
2. **Renderer Not a Trust Boundary**: Every IPC channel strictly validates incoming types with custom guards before delegating to services.
3. **Traversal Prevention**: Paths are checked via `resolveWithinRoot()`, rejecting `..`, embedded null bytes, and non-portable Windows filenames (`CON`, `PRN`, colons).
4. **Secret Shielding**: Automatically flags `.env`, `.pem`, `.key`, and other sensitive files with warnings before prompt assembly.
5. **No Telemetry**: No third-party analytics scripts, no tracking pings, and no telemetry libraries.

---

## Contributing & Testing

Pull requests and issues are welcome! Before submitting:

```bash
# 1. Ensure type consistency
npm run typecheck

# 2. Run unit tests
npm test

# 3. Check linting rules
npm run lint

# 4. Confirm build succeeds
npm run build
```

---

## License

This project is open-source under the [MIT License](LICENSE).
