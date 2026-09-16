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
import { insertCustomPrompt } from "../lib/prompt";

/** Stable key for a parsed file: ambiguous blocks have no path yet. */
export function parsedFileKey(file: ParsedFile, index: number): string {
  return file.path ?? `#${index}`;
}

export type EditorTab = "prompt" | "editor";

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
  customPrompt: string;

  rawResponse: string;
  parseResult: ParseResult | null;
  includes: Record<string, boolean>;

  applyResults: ApplyResult[] | null;
  applying: boolean;

  // Single-file editor
  editorTab: EditorTab;
  editingPath: string | null;
  editingContent: string;
  editingOriginal: string;
  editingLoading: boolean;
  saving: boolean;

  cleaning: boolean;

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
  setCustomPrompt: (value: string) => void;
  setResponse: (raw: string) => Promise<void>;
  setParsedPath: (index: number, path: string) => void;
  toggleInclude: (key: string, included: boolean) => void;
  applySelected: () => Promise<void>;
  setEditorTab: (tab: EditorTab) => void;
  openFileForEdit: (path: string) => Promise<void>;
  closeEditor: () => void;
  setEditingContent: (content: string) => void;
  saveEditingFile: () => Promise<void>;
  revertEditingFile: () => void;
  cleanBackups: () => Promise<void>;
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
  customPrompt: "",

  rawResponse: "",
  parseResult: null,
  includes: {},

  applyResults: null,
  applying: false,

  editorTab: "prompt",
  editingPath: null,
  editingContent: "",
  editingOriginal: "",
  editingLoading: false,
  saving: false,

  cleaning: false,

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
        // The previously-open file belongs to the old project; drop it rather
        // than leaving a stale path pointing into a tree that no longer exists.
        editingPath: null,
        editingContent: "",
        editingOriginal: "",
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
    const { prompt, customPrompt } = get();
    // The custom instructions are inserted at copy time rather than baked in
    // at build time, so an edit made after the last build still lands on the
    // clipboard.
    const text = insertCustomPrompt(prompt, customPrompt);
    if (text === "") return;
    await window.LARPGent.copyText(text);
    set({ notice: "Prompt copied to clipboard." });
  },

  savePrompt: async () => {
    const { prompt, customPrompt } = get();
    const text = insertCustomPrompt(prompt, customPrompt);
    if (text === "") return;
    const saved = await window.LARPGent.savePrompt(text, "prompt.md");
    if (saved) set({ notice: `Prompt saved to ${saved}` });
  },

  setCustomPrompt: (value) => set({ customPrompt: value }),

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

  setEditorTab: (tab) => set({ editorTab: tab }),

  openFileForEdit: async (path) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      set({
        editorTab: "editor",
        editingPath: path,
        editingLoading: true,
        editingContent: "",
        editingOriginal: "",
        error: null,
      });
      const content = await window.LARPGent.readFile(projectRoot, path);
      set({
        editingContent: content,
        editingOriginal: content,
        editingLoading: false,
      });
    } catch (error) {
      set({
        editingLoading: false,
        editingPath: null,
        editingContent: "",
        editingOriginal: "",
        error: message(error),
      });
    }
  },

  closeEditor: () => {
    set({
      editingPath: null,
      editingContent: "",
      editingOriginal: "",
      editingLoading: false,
    });
  },

  setEditingContent: (content) => set({ editingContent: content }),

  saveEditingFile: async () => {
    const { projectRoot, editingPath, editingContent } = get();
    if (!projectRoot || !editingPath) return;
    try {
      set({ saving: true, error: null });
      const result = await window.LARPGent.writeFile({
        projectRoot,
        path: editingPath,
        content: editingContent,
      });
      // The on-disk copy now equals the buffer; reset the original so the
      // dirty indicator clears even when the write was a no-op skip.
      set({
        editingOriginal: editingContent,
        saving: false,
        notice:
          result.status === "skipped"
            ? `${editingPath} is already up to date.`
            : `Saved ${editingPath}${result.backupPath ? ` (backup: ${result.backupPath})` : ""}.`,
      });
    } catch (error) {
      set({ saving: false, error: message(error) });
    }
  },

  revertEditingFile: () => {
    const original = get().editingOriginal;
    set({ editingContent: original });
  },

  cleanBackups: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    // Deletion is irreversible, so confirm before the sweep. The count is not
    // known until after the walk — the confirmation is intentionally about the
    // action, not a specific number.
    const confirmed = window.confirm(
      "Delete every .bak backup file generated by LARPGent under this project?\n\n" +
        "This cannot be undone.",
    );
    if (!confirmed) return;
    try {
      set({ cleaning: true, error: null });
      const result = await window.LARPGent.cleanBackups(projectRoot);
      const failedNote =
        result.errors.length > 0
          ? ` (${result.errors.length} could not be removed)`
          : "";
      set({
        cleaning: false,
        notice:
          result.deleted === 0
            ? "No .bak backup files found."
            : `Deleted ${result.deleted} .bak backup file(s)${failedNote}.`,
        error:
          result.errors.length > 0
            ? `${result.errors.length} backup file(s) could not be deleted: ${result.errors
                .map((e) => e.path)
                .join(", ")}`
            : null,
      });
    } catch (error) {
      set({ cleaning: false, error: message(error) });
    }
  },

  clearNotice: () => set({ notice: null }),
}));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
