import { create } from "zustand";
import type {
  ApplyResult,
  FileNode,
  ParsedFile,
  ParseResult,
} from "@shared/types";
import {
  collectSelectedPaths,
  setSubtreeSelected,
  updateNode,
} from "../lib/tree";

/** Stable key for a parsed file: ambiguous blocks have no path yet. */
export function parsedFileKey(file: ParsedFile, index: number): string {
  return file.path ?? `#${index}`;
}

interface AppState {
  projectRoot: string | null;
  tree: FileNode | null;
  fileCount: number;
  scanning: boolean;

  prompt: string;
  tokenCount: number;
  promptFileCount: number;
  unreadable: string[];
  building: boolean;

  rawResponse: string;
  parseResult: ParseResult | null;
  includes: Record<string, boolean>;

  applyResults: ApplyResult[] | null;
  applying: boolean;

  notice: string | null;
  error: string | null;

  openProject: () => Promise<void>;
  refreshProject: () => Promise<void>;
  openTerminal: () => Promise<void>;
  toggleNode: (id: string, selected: boolean) => void;
  toggleExpanded: (id: string) => void;
  selectAll: (selected: boolean) => void;
  buildPrompt: () => Promise<void>;
  copyPrompt: () => Promise<void>;
  savePrompt: () => Promise<void>;
  setResponse: (raw: string) => Promise<void>;
  setParsedPath: (index: number, path: string) => void;
  toggleInclude: (key: string, included: boolean) => void;
  applySelected: () => Promise<void>;
  clearNotice: () => void;
}

/**
 * Re-apply a set of previously-selected file paths to a freshly-scanned tree.
 * Paths that no longer exist are silently dropped; directories are left alone
 * so the user's expansion state survives the refresh.
 */
function restoreSelection(node: FileNode, selectedPaths: Set<string>): FileNode {
  if (node.type === "file") {
    return { ...node, selected: selectedPaths.has(node.path) };
  }
  if (!node.children) return node;
  return { ...node, children: node.children.map((child) => restoreSelection(child, selectedPaths)) };
}

export const useAppStore = create<AppState>((set, get) => ({
  projectRoot: null,
  tree: null,
  fileCount: 0,
  scanning: false,

  prompt: "",
  tokenCount: 0,
  promptFileCount: 0,
  unreadable: [],
  building: false,

  rawResponse: "",
  parseResult: null,
  includes: {},

  applyResults: null,
  applying: false,

  notice: null,
  error: null,

  openProject: async () => {
    try {
      const root = await window.LARPGent.pickDirectory();
      if (!root) return;
      set({ scanning: true, error: null });
      const scan = await window.LARPGent.scanDirectory(root);
      set({
        projectRoot: scan.root,
        tree: scan.tree,
        fileCount: scan.fileCount,
        scanning: false,
        prompt: "",
        tokenCount: 0,
        promptFileCount: 0,
        unreadable: [],
      });
    } catch (error) {
      set({ scanning: false, error: message(error) });
    }
  },

  refreshProject: async () => {
    const { projectRoot, tree } = get();
    if (!projectRoot) return;
    // Snapshot the current selection before the tree is replaced so a refresh
    // does not silently deselect everything the user had ticked.
    const previouslySelected = tree ? collectSelectedPaths(tree) : [];
    try {
      set({ scanning: true, error: null });
      const scan = await window.LARPGent.scanDirectory(projectRoot);
      const restored =
        previouslySelected.length > 0
          ? restoreSelection(scan.tree, new Set(previouslySelected))
          : scan.tree;
      set({
        tree: restored,
        fileCount: scan.fileCount,
        scanning: false,
      });
    } catch (error) {
      set({ scanning: false, error: message(error) });
    }
  },

  openTerminal: async () => {
    const projectRoot = get().projectRoot;
    if (!projectRoot) return;
    try {
      await window.LARPGent.openTerminal(projectRoot);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  toggleNode: (id, selected) => {
    const tree = get().tree;
    if (!tree) return;
    set({
      tree: updateNode(tree, id, (node) => setSubtreeSelected(node, selected)),
    });
  },

  toggleExpanded: (id) => {
    const tree = get().tree;
    if (!tree) return;
    set({
      tree: updateNode(tree, id, (node) => ({
        ...node,
        expanded: !node.expanded,
      })),
    });
  },

  selectAll: (selected) => {
    const tree = get().tree;
    if (!tree) return;
    set({ tree: setSubtreeSelected(tree, selected) });
  },

  buildPrompt: async () => {
    const { projectRoot, tree } = get();
    if (!projectRoot || !tree) return;
    const files = collectSelectedPaths(tree);
    if (files.length === 0) {
      set({ error: "Select at least one file first." });
      return;
    }
    try {
      set({ building: true, error: null });
      const result = await window.LARPGent.buildPrompt({ projectRoot, files });
      set({
        prompt: result.prompt,
        tokenCount: result.tokenCount,
        promptFileCount: result.fileCount,
        unreadable: result.unreadable,
        building: false,
      });
    } catch (error) {
      set({ building: false, error: message(error) });
    }
  },

  copyPrompt: async () => {
    const prompt = get().prompt;
    if (!prompt) return;
    await window.LARPGent.copyText(prompt);
    set({ notice: "Prompt copied to clipboard." });
  },

  savePrompt: async () => {
    const prompt = get().prompt;
    if (!prompt) return;
    const saved = await window.LARPGent.savePrompt(prompt, "prompt.md");
    if (saved) set({ notice: `Prompt saved to ${saved}` });
  },

  setResponse: async (raw) => {
    set({ rawResponse: raw, applyResults: null, error: null });
    if (raw.trim() === "") {
      set({ parseResult: null, includes: {} });
      return;
    }
    try {
      const result = await window.LARPGent.parseResponse(raw);
      set({
        parseResult: result,
        includes: Object.fromEntries(
          result.files.map((file, index) => [parsedFileKey(file, index), true]),
        ),
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  setParsedPath: (index, path) => {
    const parseResult = get().parseResult;
    if (!parseResult) return;
    const files = parseResult.files.map((file, current) =>
      current === index
        ? { ...file, path, pathSource: "user" as const, ambiguous: false }
        : file,
    );
    const includes = { ...get().includes };
    delete includes[`#${index}`];
    includes[path] = includes[path] ?? true;
    set({ parseResult: { ...parseResult, files }, includes });
  },

  toggleInclude: (key, included) => {
    set({ includes: { ...get().includes, [key]: included } });
  },

  applySelected: async () => {
    const { projectRoot, parseResult, includes } = get();
    if (!projectRoot || !parseResult) return;

    const files = parseResult.files
      .map((file, index) => ({ file, key: parsedFileKey(file, index) }))
      .filter(
        (
          entry,
        ): entry is { file: ParsedFile & { path: string }; key: string } =>
          entry.file.path !== null && includes[entry.key] === true,
      )
      .map((entry) => ({ path: entry.file.path, content: entry.file.content }));

    if (files.length === 0) {
      set({ error: "No files selected to apply." });
      return;
    }

    try {
      set({ applying: true, error: null });
      const results = await window.LARPGent.applyFiles({ projectRoot, files });
      set({ applyResults: results, applying: false });
    } catch (error) {
      set({ applying: false, error: message(error) });
    }
  },

  clearNotice: () => set({ notice: null }),
}));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
