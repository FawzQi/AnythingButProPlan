import { create } from "zustand";
import type {
  ApplyResult,
  FileNode,
  GitStatus,
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

export type EditorTab = "prompt" | "editor" | "source";

interface AppState {
  projectRoot: string | null;
  tree: FileNode | null;
  fileCount: number;
  scanning: boolean;

  prompt: string;
  tokenCount: number;
  promptFileCount: number;
  unreadable: string[];
  /**
   * Files in the last-built prompt whose names match a sensitive-file pattern.
   * The UI surfaces these so the user knows what they are about to paste into
   * a chat UI. Never used to filter — the prompt already contains them.
   */
  sensitiveFiles: string[];
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
  /**
   * Path of the file currently being removed by the tree's delete button.
   * `null` when no delete is in flight. Kept separate from `saving` so the
   * two operations cannot wedge each other.
   */
  deletingPath: string | null;

  /**
   * Result of the most recent `git status`. `null` when the project root is
   * not a repository — the Source Control tab shows an Initialize button in
   * that case. `undefined` means "not yet loaded", which is distinguished
   * from `null` so the initial paint can show a loading state rather than
   * flashing the init prompt.
   */
  gitStatus: GitStatus | null | undefined;
  /** True while a status refresh is in flight. */
  gitStatusLoading: boolean;
  /** True while any Git mutation (stage, commit, discard, init) is in flight. */
  gitBusy: boolean;
  /** Draft commit message bound to the textarea in the Source Control tab. */
  gitCommitMessage: string;

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
  deleteFileFromTree: (path: string) => Promise<void>;
  refreshGitStatus: () => Promise<void>;
  initGitRepo: () => Promise<void>;
  stageGitPath: (path: string) => Promise<void>;
  unstageGitPath: (path: string) => Promise<void>;
  discardGitPath: (path: string, untracked: boolean) => Promise<void>;
  commitGitChanges: () => Promise<void>;
  setGitCommitMessage: (message: string) => void;
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
  sensitiveFiles: [],
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
  deletingPath: null,

  gitStatus: undefined,
  gitStatusLoading: false,
  gitBusy: false,
  gitCommitMessage: "",

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
        sensitiveFiles: [],
        // The previously-open file belongs to the old project; drop it rather
        // than leaving a stale path pointing into a tree that no longer exists.
        editingPath: null,
        editingContent: "",
        editingOriginal: "",
        // Reset git state — the previous project's status is meaningless
        // here, and `undefined` puts the Source Control tab back into its
        // loading state rather than showing the old repo's branch.
        gitStatus: undefined,
        gitCommitMessage: "",
      });
      await get().refreshGitStatus();
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
      // A scan can pick up files changed outside the app, so refresh Git
      // status alongside it.
      await get().refreshGitStatus();
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
    // With no project open there are no files to include, but the base
    // prompt — the output contract alone — is still useful: the user may be
    // starting a fresh project and just wants the instruction block, with
    // the additional instructions appended by the PromptTab, to paste
    // somewhere. Only require a selection when there *is* a project to
    // select from.
    const files = projectRoot && tree ? collectSelectedPaths(tree) : [];
    if (projectRoot && files.length === 0) {
      set({ error: "Select at least one file first." });
      return;
    }
    try {
      set({ building: true, error: null });
      const result = await window.LARPGent.buildPrompt({
        projectRoot: projectRoot ?? "",
        files,
      });
      set({
        prompt: result.prompt,
        tokenCount: result.tokenCount,
        promptFileCount: result.fileCount,
        unreadable: result.unreadable,
        sensitiveFiles: result.sensitiveFiles,
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
      .map((entry) => ({
        path: entry.file.path,
        content: entry.file.content,
        // Patch files carry a SEARCH/REPLACE payload instead of full content;
        // the applier branches on the presence of this field.
        ...(entry.file.patches && entry.file.patches.length > 0
          ? { patches: entry.file.patches }
          : {}),
        // A delete directive carries no payload at all — the flag alone
        // tells the applier to rename the file to a `.bak` sibling.
        ...(entry.file.delete === true ? { delete: true as const } : {}),
      }));

    if (files.length === 0) {
      set({ error: "No files selected to apply." });
      return;
    }

    try {
      set({ applying: true, error: null });
      const results = await window.LARPGent.applyFiles({ projectRoot, files });
      set({ applyResults: results, applying: false });
      // Applied changes touch the working tree; refresh Git status so the
      // Source Control tab reflects what the user just wrote.
      await get().refreshGitStatus();
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
      await get().refreshGitStatus();
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

  deleteFileFromTree: async (path) => {
    const { projectRoot, editingPath } = get();
    if (!projectRoot) return;
    const confirmed = window.confirm(
      `Delete ${path}?\n\n` +
        "Its contents are preserved as a .bak sibling so the change can be undone outside the app.",
    );
    if (!confirmed) return;
    try {
      set({ deletingPath: path, error: null });
      const result = await window.LARPGent.deleteFile({
        projectRoot,
        path,
      });
      if (result.status === "not-found") {
        set({
          deletingPath: null,
          notice: `${path} was already gone.`,
        });
      } else {
        set({
          deletingPath: null,
          notice:
            `Deleted ${path}` +
            (result.backupPath ? ` (backup: ${result.backupPath}).` : "."),
        });
      }
      // The deleted file must not linger in the tree, and if it was open in
      // the editor the buffer now points at a file that no longer exists.
      if (editingPath === path) {
        set({
          editingPath: null,
          editingContent: "",
          editingOriginal: "",
          editingLoading: false,
        });
      }
      await get().refreshProject();
      await get().refreshGitStatus();
    } catch (error) {
      set({ deletingPath: null, error: message(error) });
    }
  },

  refreshGitStatus: async () => {
    const { projectRoot } = get();
    if (!projectRoot) {
      set({ gitStatus: null, gitStatusLoading: false });
      return;
    }
    set({ gitStatusLoading: true, error: null });
    try {
      const status = await window.LARPGent.gitStatus(projectRoot);
      // A project switch while the call was in flight invalidates the
      // result; drop it rather than applying to the wrong root.
      if (get().projectRoot !== projectRoot) return;
      set({ gitStatus: status, gitStatusLoading: false });
    } catch (error) {
      if (get().projectRoot !== projectRoot) return;
      // A Git failure (missing binary, corrupt repo) still leaves the tab
      // usable — `null` tells it to show the init prompt, and the banner
      // reports the reason.
      set({ gitStatus: null, gitStatusLoading: false, error: message(error) });
    }
  },

  initGitRepo: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    const confirmed = window.confirm(
      `Initialize a Git repository in ${projectRoot}?\n\n` +
        "This creates a .git directory. No files are committed yet.",
    );
    if (!confirmed) return;
    try {
      set({ gitBusy: true, error: null });
      const result = await window.LARPGent.gitInit({ projectRoot });
      set({
        gitBusy: false,
        notice: result.created
          ? "Git repository initialized."
          : "This folder is already a Git repository.",
      });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  stageGitPath: async (path) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      set({ gitBusy: true, error: null });
      await window.LARPGent.gitStage({ projectRoot, path });
      set({ gitBusy: false });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  unstageGitPath: async (path) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      set({ gitBusy: true, error: null });
      await window.LARPGent.gitUnstage({ projectRoot, path });
      set({ gitBusy: false });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  discardGitPath: async (path, untracked) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    const confirmed = window.confirm(
      untracked
        ? `Delete untracked file ${path}?\n\n` +
            "Its contents are preserved as a .bak sibling so the discard can be undone."
        : `Discard changes to ${path}?\n\n` +
            "The working tree version is replaced with the staged version. This cannot be undone from inside LARPGent.",
    );
    if (!confirmed) return;
    try {
      set({ gitBusy: true, error: null });
      await window.LARPGent.gitDiscard({ projectRoot, path, untracked });
      set({ gitBusy: false, notice: `Discarded changes to ${path}.` });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  commitGitChanges: async () => {
    const { projectRoot, gitCommitMessage, gitStatus } = get();
    if (!projectRoot) return;
    if (!gitStatus || gitStatus.staged.length === 0) {
      set({ error: "Nothing staged to commit." });
      return;
    }
    if (gitCommitMessage.trim() === "") {
      set({ error: "Enter a commit message first." });
      return;
    }
    try {
      set({ gitBusy: true, error: null });
      const result = await window.LARPGent.gitCommit({
        projectRoot,
        message: gitCommitMessage,
      });
      set({
        gitBusy: false,
        gitCommitMessage: "",
        notice: result.commitHash
          ? `Committed ${result.commitHash.slice(0, 7)}.`
          : "Committed.",
      });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  setGitCommitMessage: (message) => set({ gitCommitMessage: message }),

  clearNotice: () => set({ notice: null }),
}));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}