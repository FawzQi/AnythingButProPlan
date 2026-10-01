import { create } from "zustand";
import type {
  AiProviderId,
  AiProviderInfo,
  AiSettings,
  AiSettingsSaveRequest,
  AiSuggestion,
  ApplyFileInput,
  ApplyResult,
  FileNode,
  GitStatus,
  ParsedFile,
  ParseResult,
  RecentFolder,
  WebChatTargetId,
  WebChatTargetInfo,
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

export type EditorTab = "prompt" | "editor" | "source" | "settings";

interface AppState {
  projectRoot: string | null;
  tree: FileNode | null;
  fileCount: number;
  scanning: boolean;

  /**
   * Saved folders for the "Recent" dropdown. Loaded once on mount and
   * refreshed whenever a folder is opened, so the list is always in sync
   * with what the main process has persisted.
   */
  recentFolders: RecentFolder[];
  recentFoldersLoading: boolean;

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

  /**
   * AI provider configuration. `null` before the settings load completes.
   * `providers` is the catalogue the Settings tab renders; `settings` is the
   * user's current selection, with `hasApiKey` reflecting whether a key was
   * stored per provider (the key itself never reaches the renderer).
   */
  aiProviders: AiProviderInfo[];
  /** Catalogue of web chat sites the "Send to web chat" button can drive. */
  webChatTargets: WebChatTargetInfo[];
  aiSettings: AiSettings | null;
  aiSettingsLoading: boolean;
  /**
   * Live model catalogue per provider, keyed by provider id. Populated on
   * demand from the provider's own list endpoint — a hardcoded array is
   * never the source of truth, because vendors retire model names without
   * notice and the stale name produces a 404 at request time.
   */
  aiModelsByProvider: Partial<Record<AiProviderId, string[]>>;
  aiModelsLoading: boolean;
  /** True while a suggest-files request is in flight. */
  aiSuggesting: boolean;
  /** Result of the most recent suggest-files call, or null. */
  aiLastSuggestion: AiSuggestion | null;
  /** Token count of the generated codebase map/skeleton used for suggest files. */
  mapTokenCount: number | null;

  /**
   * True while a web chat send is in flight. The whole round-trip — typing,
   * submitting, waiting for the reply to finish streaming, scraping — runs
   * inside the main process, so the renderer only sees the two edges.
   */
  webChatSending: boolean;

  notice: string | null;
  error: string | null;

  loadRecentFolders: () => Promise<void>;
  openProjectByPath: (path: string) => Promise<void>;
  removeRecentFolder: (path: string) => Promise<void>;
  clearRecentFolders: () => Promise<void>;

  loadAiSettings: () => Promise<void>;
  saveAiSettings: (request: AiSettingsSaveRequest) => Promise<void>;
  loadAiModels: (provider: AiProviderId) => Promise<void>;
  suggestFiles: () => Promise<void>;
  calculateMapTokens: () => Promise<void>;
  sendToWebChat: () => Promise<void>;
  openWebChat: () => Promise<void>;

  openProject: () => Promise<void>;
  refreshProject: () => Promise<void>;
  openTerminal: () => Promise<void>;
  toggleNode: (id: string, selected: boolean) => void;
  toggleExpanded: (id: string) => void;
  selectAll: (selected: boolean) => void;
  buildPrompt: () => Promise<void>;
  clearPrompt: () => void;
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
  deleteFileFromTree: (path: string) => Promise<void>;
  refreshGitStatus: () => Promise<void>;
  initGitRepo: () => Promise<void>;
  stageGitPath: (path: string) => Promise<void>;
  stageAllGitPaths: () => Promise<void>;
  unstageGitPath: (path: string) => Promise<void>;
  discardGitPath: (path: string, untracked: boolean) => Promise<void>;
  discardAllGitPaths: () => Promise<void>;
  commitGitChanges: () => Promise<void>;
  setGitCommitMessage: (message: string) => void;
  clearNotice: () => void;
}

/**
 * Re-apply a set of previously-selected file paths to a freshly-scanned tree.
 * Paths that no longer exist are silently dropped; directories are left alone
 * so the user's expansion state survives the refresh.
 */
function restoreSelection(
  node: FileNode,
  selectedPaths: Set<string>,
): FileNode {
  if (node.type === "file") {
    return { ...node, selected: selectedPaths.has(node.path) };
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((child) =>
      restoreSelection(child, selectedPaths),
    ),
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  projectRoot: null,
  tree: null,
  fileCount: 0,
  scanning: false,

  recentFolders: [],
  recentFoldersLoading: false,

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

  deletingPath: null,

  gitStatus: undefined,
  gitStatusLoading: false,
  gitBusy: false,
  gitCommitMessage: "",

  aiProviders: [],
  webChatTargets: [],
  aiSettings: null,
  aiSettingsLoading: false,
  aiModelsByProvider: {},
  aiModelsLoading: false,
  aiSuggesting: false,
  aiLastSuggestion: null,
  mapTokenCount: null,

  webChatSending: false,

  notice: null,
  error: null,

  loadRecentFolders: async () => {
    set({ recentFoldersLoading: true });
    try {
      const folders = await window.AnythingButProPlan.recentFoldersList();
      set({ recentFolders: folders, recentFoldersLoading: false });
    } catch (error) {
      // A failed load is not fatal — the dropdown just shows an empty
      // list. Log it rather than pushing an error banner for a shortcut
      // that the user can live without.
      set({ recentFoldersLoading: false });
      console.warn("Failed to load recent folders:", message(error));
    }
  },

  openProjectByPath: async (root) => {
    try {
      set({ scanning: true, error: null });
      const scan = await window.AnythingButProPlan.scanDirectory(root);
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
        mapTokenCount: null,
      });
      // Save the folder to the recent list before anything else. The
      // main process re-sorts, so a folder reopened from the dropdown
      // immediately moves to the top of the list.
      try {
        const folders = await window.AnythingButProPlan.recentFoldersAdd(
          scan.root,
        );
        set({ recentFolders: folders });
      } catch (error) {
        console.warn("Failed to save recent folder:", message(error));
      }
      await get().refreshGitStatus();
      await get().calculateMapTokens();
    } catch (error) {
      set({ scanning: false, error: message(error) });
    }
  },

  removeRecentFolder: async (path) => {
    try {
      const folders = await window.AnythingButProPlan.recentFoldersRemove(path);
      set({ recentFolders: folders });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  clearRecentFolders: async () => {
    try {
      const folders = await window.AnythingButProPlan.recentFoldersClear();
      set({ recentFolders: folders });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  loadAiSettings: async () => {
    set({ aiSettingsLoading: true });
    try {
      const result = await window.AnythingButProPlan.aiGetSettings();
      set({
        aiProviders: result.providers,
        webChatTargets: result.webChatTargets,
        aiSettings: result.settings,
        aiSettingsLoading: false,
      });
    } catch (error) {
      set({ aiSettingsLoading: false, error: message(error) });
    }
  },

  saveAiSettings: async (request) => {
    try {
      const settings = await window.AnythingButProPlan.aiSaveSettings(request);
      set({ aiSettings: settings, notice: "AI settings saved." });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  loadAiModels: async (provider) => {
    set({ aiModelsLoading: true });
    try {
      const models = await window.AnythingButProPlan.aiListModels(provider);
      set((state) => ({
        aiModelsByProvider: {
          ...state.aiModelsByProvider,
          [provider]: models,
        },
        aiModelsLoading: false,
      }));
    } catch (error) {
      // A failed list is not a fatal error — the settings panel falls back
      // to the provider's seed list, and the error banner is reserved for
      // actions that actually blocked the user.
      set({ aiModelsLoading: false });
      console.warn("Failed to list models:", message(error));
    }
  },

  calculateMapTokens: async () => {
    const { projectRoot, tree } = get();
    if (!projectRoot || !tree) return;
    const filePaths: string[] = [];
    const walk = (node: FileNode): void => {
      if (node.type === "file") filePaths.push(node.path);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    if (filePaths.length === 0) {
      set({ mapTokenCount: 0 });
      return;
    }
    try {
      const suggestion = await window.AnythingButProPlan.aiSuggestFiles({
        projectRoot,
        filePaths,
        instruction: "",
        dryRun: true,
      });
      set({ mapTokenCount: suggestion.mapTokens });
    } catch (error) {
      console.warn("Failed to calculate map tokens:", message(error));
    }
  },

  suggestFiles: async () => {
    const { projectRoot, tree, customPrompt } = get();
    if (!projectRoot || !tree) {
      set({ error: "Open a project before asking the AI to suggest files." });
      return;
    }
    if (customPrompt.trim() === "") {
      set({
        error:
          "Type a description of the change in Additional instructions first.",
      });
      return;
    }
    const filePaths: string[] = [];
    const walk = (node: FileNode): void => {
      if (node.type === "file") filePaths.push(node.path);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    if (filePaths.length === 0) {
      set({ error: "The project has no promptable files." });
      return;
    }
    try {
      set({ aiSuggesting: true, error: null, aiLastSuggestion: null });
      const suggestion = await window.AnythingButProPlan.aiSuggestFiles({
        projectRoot,
        filePaths,
        instruction: customPrompt,
      });
      set({
        aiSuggesting: false,
        aiLastSuggestion: suggestion,
        // The local, Jev, and LLM methods never build the full skeleton, so
        // their `mapTokens` is zero or a targeted candidate count. Overwriting
        // the cached full-map count with any of them would silently disable
        // the "map is too big" warning for the current method on the next
        // project refresh. Keep the previous value for those three methods.
        ...(suggestion.method === "gitnexus-only" ||
        suggestion.method === "gitnexus-jev" ||
        suggestion.method === "gitnexus-llm"
          ? {}
          : { mapTokenCount: suggestion.mapTokens }),
      });
      // Replace the current selection with the AI's pick. Any file not in
      // the suggestion is deselected — the whole point of the feature is to
      // narrow a sprawling selection down to what matters, so additive
      // selection would defeat it.
      const chosen = new Set(suggestion.paths);
      const apply = (node: FileNode): FileNode => {
        if (node.type === "file") {
          return { ...node, selected: chosen.has(node.path) };
        }
        // Preserve `children: undefined` for childless directories rather
        // than normalising it to an empty array — the rest of the app
        // distinguishes the two, and a directory that becomes `children: []`
        // would render one frame differently on the next flatten.
        return node.children
          ? { ...node, children: node.children.map(apply) }
          : { ...node };
      };
      set({ tree: apply(tree) });
      set({
        notice:
          suggestion.paths.length === 0
            ? "The AI did not suggest any files."
            : `Selected ${suggestion.paths.length} file(s) via ${suggestion.provider}.`,
      });
    } catch (error) {
      set({ aiSuggesting: false, error: message(error) });
    }
  },

  sendToWebChat: async () => {
    const { prompt, customPrompt, aiSettings } = get();
    // Two valid send shapes:
    //
    //   1. A prompt has been generated. The input instruction is inserted
    //      into it, exactly as Copy and Save do, so the site sees the whole
    //      request — file bodies plus the output contract plus the ask.
    //
    //   2. No prompt exists (never generated, or cleared). The input
    //      instruction goes on its own. This is the "use the web chat as a
    //      general assistant" path: the user describes what they want and
    //      the site answers, with no repo context and no output contract in
    //      the way. Requiring a built prompt here would force the user to
    //      select files just to send a one-line question.
    const text =
      prompt === ""
        ? customPrompt.trim()
        : insertCustomPrompt(prompt, customPrompt);
    if (text === "") {
      set({
        error:
          "Type an input instruction or generate a prompt before sending to a web chat.",
      });
      return;
    }
    const target: WebChatTargetId = aiSettings?.webChatTarget ?? "deepseek";
    try {
      set({ webChatSending: true, error: null, notice: null });
      const result = await window.AnythingButProPlan.webChatSend({
        target,
        prompt: text,
      });
      if (!result.ok) {
        set({
          webChatSending: false,
          error: result.error ?? "The web chat did not return a response.",
        });
        return;
      }
      set({ webChatSending: false });
      // The scraped text is fed through the same parser the paste path uses,
      // so the Response panel behaves identically no matter where the reply
      // came from. `setResponse` writes `rawResponse`, which the Response
      // panel's textarea mirrors — the reply appears in the input box.
      await get().setResponse(result.text ?? "");
      set({ notice: "Response received from the web chat." });
    } catch (error) {
      set({ webChatSending: false, error: message(error) });
    }
  },

  openWebChat: async () => {
    const target = get().aiSettings?.webChatTarget ?? "deepseek";
    try {
      await window.AnythingButProPlan.webChatOpen(target);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  openProject: async () => {
    try {
      const root = await window.AnythingButProPlan.pickDirectory();
      if (!root) return;
      await get().openProjectByPath(root);
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
      const scan = await window.AnythingButProPlan.scanDirectory(projectRoot);
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
      await get().calculateMapTokens();
    } catch (error) {
      set({ scanning: false, error: message(error) });
    }
  },

  openTerminal: async () => {
    const projectRoot = get().projectRoot;
    if (!projectRoot) return;
    try {
      await window.AnythingButProPlan.openTerminal(projectRoot);
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
      const result = await window.AnythingButProPlan.buildPrompt({
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

  clearPrompt: () => {
    // Reset only the generated prompt. The input instruction is deliberately
    // left alone: clearing is how the user gets back to the
    // instruction-only send path, not a way to wipe what they typed.
    set({
      prompt: "",
      tokenCount: 0,
      promptFileCount: 0,
      unreadable: [],
      sensitiveFiles: [],
    });
  },

  copyPrompt: async () => {
    const { prompt, customPrompt } = get();
    // The custom instructions are inserted at copy time rather than baked in
    // at build time, so an edit made after the last build still lands on the
    // clipboard.
    const text = insertCustomPrompt(prompt, customPrompt);
    if (text === "") return;
    await window.AnythingButProPlan.copyText(text);
    set({ notice: "Prompt copied to clipboard." });
  },

  savePrompt: async () => {
    const { prompt, customPrompt } = get();
    const text = insertCustomPrompt(prompt, customPrompt);
    if (text === "") return;
    const saved = await window.AnythingButProPlan.savePrompt(text, "prompt.md");
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
      const result = await window.AnythingButProPlan.parseResponse(raw);
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
    // Only an `unresolved` entry can be given a path from the UI — the
    // input that calls this action renders only when the entry has none.
    const files = parseResult.files.map((file, current) => {
      if (current !== index || file.kind !== "unresolved") return file;
      return {
        ...file,
        kind: "full" as const,
        path,
        pathSource: "user" as const,
      };
    });
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

    const files: ApplyFileInput[] = [];
    for (const [index, file] of parseResult.files.entries()) {
      const key = parsedFileKey(file, index);
      if (includes[key] !== true) continue;
      // Unresolved entries have no target path yet — the user must supply
      // one before the entry can be applied. Skipping here is what keeps
      // the user-assisted strategy from erroring on every unresolved block.
      if (file.kind === "unresolved") continue;
      if (file.kind === "delete") {
        files.push({ path: file.path, content: "", delete: true });
        continue;
      }
      if (file.kind === "patch") {
        files.push({
          path: file.path,
          content: file.content,
          patches: file.patches,
        });
        continue;
      }
      files.push({ path: file.path, content: file.content });
    }

    if (files.length === 0) {
      set({ error: "No files selected to apply." });
      return;
    }

    try {
      set({ applying: true, error: null });
      const results = await window.AnythingButProPlan.applyFiles({
        projectRoot,
        files,
      });
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
      const content = await window.AnythingButProPlan.readFile(
        projectRoot,
        path,
      );
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
      const result = await window.AnythingButProPlan.writeFile({
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
            : `Saved ${editingPath}.`,
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

  deleteFileFromTree: async (path) => {
    const { projectRoot, editingPath } = get();
    if (!projectRoot) return;
    const confirmed = await window.AnythingButProPlan.confirmDialog({
      message: `Delete ${path}?`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      set({ deletingPath: path, error: null });
      const result = await window.AnythingButProPlan.deleteFile({
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
          notice: `Deleted ${path}.`,
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
      const status = await window.AnythingButProPlan.gitStatus(projectRoot);
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
    const confirmed = await window.AnythingButProPlan.confirmDialog({
      message: `Initialize a Git repository in ${projectRoot}?`,
      detail: "This creates a .git directory. No files are committed yet.",
      confirmLabel: "Initialize",
    });
    if (!confirmed) return;
    try {
      set({ gitBusy: true, error: null });
      const result = await window.AnythingButProPlan.gitInit({ projectRoot });
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
      await window.AnythingButProPlan.gitStage({ projectRoot, path });
      set({ gitBusy: false });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  stageAllGitPaths: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      set({ gitBusy: true, error: null });
      await window.AnythingButProPlan.gitStageAll(projectRoot);
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
      await window.AnythingButProPlan.gitUnstage({ projectRoot, path });
      set({ gitBusy: false });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  discardGitPath: async (path, untracked) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    const confirmed = await window.AnythingButProPlan.confirmDialog(
      untracked
        ? {
            message: `Delete untracked file ${path}?`,
            confirmLabel: "Delete",
            tone: "danger",
          }
        : {
            message: `Discard changes to ${path}?`,
            detail:
              "The working tree version is replaced with the staged version. This cannot be undone from inside AnythingButProPlan.",
            confirmLabel: "Discard",
            tone: "warning",
          },
    );
    if (!confirmed) return;
    try {
      set({ gitBusy: true, error: null });
      await window.AnythingButProPlan.gitDiscard({
        projectRoot,
        path,
        untracked,
      });
      set({ gitBusy: false, notice: `Discarded changes to ${path}.` });
      await get().refreshGitStatus();
    } catch (error) {
      set({ gitBusy: false, error: message(error) });
    }
  },

  discardAllGitPaths: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    const confirmed = await window.AnythingButProPlan.confirmDialog({
      message: "Discard every unstaged change?",
      detail:
        "Tracked files are restored to their staged version. Untracked files are left alone. This cannot be undone from inside AnythingButProPlan.",
      confirmLabel: "Discard all",
      tone: "warning",
    });
    if (!confirmed) return;
    try {
      set({ gitBusy: true, error: null });
      await window.AnythingButProPlan.gitDiscardAll(projectRoot);
      set({ gitBusy: false, notice: "Discarded all unstaged changes." });
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
      const result = await window.AnythingButProPlan.gitCommit({
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