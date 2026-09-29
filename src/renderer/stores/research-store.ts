import { create } from "zustand";
import type {
  AiProviderId,
  ConversionMode,
  ConvertProgress,
  ExtractionEngine,
  DocumentEntry,
  IndexBuildProgress,
  IndexStatus,
  ResearchPromptMode,
  ResearchPromptResult,
} from "@shared/types";
import { DEFAULT_VISION_PROVIDER } from "@shared/vision-providers";
import { useAppStore } from "./app-store";

/**
 * Research mode's own store.
 *
 * It reads `projectRoot` from the app store rather than keeping a copy: the
 * folder picker, the coding-mode scanner, and the git panel all write that
 * one value, and a second copy in here would go stale the moment the user
 * opens a different folder while research mode is on screen.
 *
 * Errors and notices are local to this store because they are rendered in
 * the research panel. The app store's `error` field feeds the header banner,
 * which is wired to coding-mode actions; routing a failed conversion through
 * it would show the message next to an unrelated prompt build.
 */

const EMPTY_INDEX: IndexStatus = {
  built: false,
  documentCount: 0,
  chunkCount: 0,
  dimensions: 0,
  model: null,
  builtAt: null,
};

/** Which panel the research dashboard is showing. */
export type ResearchTab = "prompt" | "index";

export interface ResearchState {
  docsDirExists: boolean;
  sourceDir: 'docs' | 'root';
  documents: DocumentEntry[];
  selected: string[];
  scanning: boolean;

  conversionMode: ConversionMode;
  engine: ExtractionEngine;
  /** Per-conversion vision provider — never a global setting. */
  visionProvider: AiProviderId;
  converting: boolean;
  convertProgress: ConvertProgress | null;

  index: IndexStatus;
  indexBuilding: boolean;
  indexProgress: IndexBuildProgress | null;

  tab: ResearchTab;
  promptMode: ResearchPromptMode;
  question: string;
  topK: number;
  rerank: boolean;
  prompt: string;
  promptResult: ResearchPromptResult | null;
  buildingPrompt: boolean;

  error: string | null;
  notice: string | null;

  refreshDocuments: () => Promise<void>;
  toggleSelected: (path: string) => void;
  setSelection: (paths: string[]) => void;
  setConversionMode: (mode: ConversionMode) => void;
  setEngine: (engine: ExtractionEngine) => void;
  setVisionProvider: (provider: AiProviderId) => void;
  convertDocuments: (paths: string[]) => Promise<void>;
  cancel: () => Promise<void>;
  buildIndex: () => Promise<void>;
  setPromptMode: (mode: ResearchPromptMode) => void;
  setQuestion: (question: string) => void;
  setTopK: (topK: number) => void;
  setRerank: (rerank: boolean) => void;
  buildPrompt: () => Promise<void>;
  copyPrompt: () => Promise<void>;
  savePrompt: () => Promise<void>;
  setTab: (tab: ResearchTab) => void;
  clearNotice: () => void;
  setProgress: (progress: ConvertProgress) => void;
  setIndexProgress: (progress: IndexBuildProgress) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRootOrFail(): string | null {
  const root = useAppStore.getState().projectRoot;
  if (root === null || root === "") {
    useAppStore.setState({ error: "Open a project folder first." });
    return null;
  }
  return root;
}

export const useResearchStore = create<ResearchState>((set, get) => ({
  docsDirExists: true,
  sourceDir: "docs",
  documents: [],
  selected: [],
  scanning: false,

  conversionMode: "text",
  engine: "auto",
  visionProvider: DEFAULT_VISION_PROVIDER,
  converting: false,
  convertProgress: null,

  index: EMPTY_INDEX,
  indexBuilding: false,
  indexProgress: null,

  tab: "prompt",
  promptMode: "full",
  question: "",
  topK: 8,
  rerank: false,
  prompt: "",
  promptResult: null,
  buildingPrompt: false,

  error: null,
  notice: null,

  refreshDocuments: async () => {
    const projectRoot = projectRootOrFail();
    if (projectRoot === null) return;
    set({ scanning: true, error: null });
    try {
      const result = await window.AnythingButProPlan.researchScan(projectRoot);
      // A document that disappeared from disk is dropped from the selection
      // here rather than kept as a phantom the convert call would report as
      // failed.
      const known = new Set(result.documents.map((document) => document.path));
      set({
        docsDirExists: result.docsDirExists,
        sourceDir: result.sourceDir,
        documents: result.documents,
        index: result.index,
        selected: get().selected.filter((path) => known.has(path)),
        scanning: false,
      });
    } catch (error) {
      set({ scanning: false, error: message(error) });
    }
  },

  toggleSelected: (path) => {
    const selected = get().selected;
    set({
      selected: selected.includes(path)
        ? selected.filter((candidate) => candidate !== path)
        : [...selected, path],
    });
  },

  setSelection: (paths) => set({ selected: paths }),

  setConversionMode: (mode) => set({ conversionMode: mode }),

  setEngine: (engine) => set({ engine }),

  setVisionProvider: (provider) => set({ visionProvider: provider }),

  convertDocuments: async (paths) => {
    const projectRoot = projectRootOrFail();
    if (projectRoot === null) return;
    const targets = paths.length > 0 ? paths : get().documents.map((d) => d.path);
    if (targets.length === 0) {
      set({ error: "No documents to convert." });
      return;
    }
    set({
      converting: true,
      error: null,
      notice: null,
      convertProgress: null,
    });
    try {
      const result = await window.AnythingButProPlan.researchConvert({
        projectRoot,
        docPaths: targets,
        mode: get().conversionMode,
        engine: get().engine,
        visionProvider: get().visionProvider,
      });
      set({
        converting: false,
        convertProgress: null,
        documents: result.documents,
      });
      // A batch that partly failed is reported as a summary, never as a
      // silent success. The failed documents keep their error in the list.
      const parts: string[] = [];
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length} failed`);
      }
      if (result.cancelled) parts.push("cancelled");
      set({
        notice:
          result.failed.length === 0 && !result.cancelled
            ? `Converted ${targets.length} document(s).`
            : `Conversion stopped — ${parts.join(", ")}. The list below shows what happened to each document.`,
        error:
          result.failed.length > 0
            ? `${result.failed[0]?.path}: ${result.failed[0]?.error}`
            : null,
      });
    } catch (error) {
      set({ converting: false, convertProgress: null, error: message(error) });
    }
  },

  cancel: async () => {
    const projectRoot = useAppStore.getState().projectRoot;
    if (projectRoot === null) return;
    await window.AnythingButProPlan.researchCancel({ projectRoot });
  },

  buildIndex: async () => {
    const projectRoot = projectRootOrFail();
    if (projectRoot === null) return;
    set({ indexBuilding: true, error: null, notice: null, indexProgress: null });
    try {
      const result = await window.AnythingButProPlan.researchBuildIndex({
        projectRoot,
        docPaths: get().selected,
      });
      set({ indexBuilding: false, index: result.index, indexProgress: null });
      set({
        notice:
          result.skipped.length === 0
            ? `Indexed ${result.index.chunkCount.toLocaleString()} chunk(s) from ${result.index.documentCount} document(s).`
            : `Indexed ${result.index.chunkCount.toLocaleString()} chunk(s). Skipped ${result.skipped.length} document(s) that have not been converted.`,
      });
      // Documents carry their own chunk counts, so the list refreshes rather
      // than the UI deriving them from the index.
      await get().refreshDocuments();
    } catch (error) {
      set({ indexBuilding: false, indexProgress: null, error: message(error) });
    }
  },

  /**
   * Copy and save act on the research prompt, not the coding one: the app
   * store's versions of these two actions read its own `prompt` field, which
   * is the codebase prompt. Sharing them would silently copy the wrong text
   * once both modes have been used in a session.
   */
  copyPrompt: async () => {
    const text = get().prompt;
    if (text === "") return;
    await window.AnythingButProPlan.copyText(text);
    set({ notice: "Research prompt copied to clipboard." });
  },

  savePrompt: async () => {
    const text = get().prompt;
    if (text === "") return;
    const saved = await window.AnythingButProPlan.savePrompt(
      text,
      "research-prompt.md",
    );
    if (saved !== null) set({ notice: `Prompt saved to ${saved}` });
  },

  setTab: (tab) => set({ tab }),

  setPromptMode: (mode) => set({ promptMode: mode }),

  setQuestion: (question) => set({ question }),

  setTopK: (topK) => set({ topK }),

  setRerank: (rerank) => set({ rerank }),

  buildPrompt: async () => {
    const projectRoot = projectRootOrFail();
    if (projectRoot === null) return;
    set({ buildingPrompt: true, error: null, notice: null });
    try {
      const result = await window.AnythingButProPlan.researchBuildPrompt({
        projectRoot,
        mode: get().promptMode,
        docPaths: get().selected,
        question: get().question,
        topK: get().topK,
        rerank: get().rerank,
      });
      set({ buildingPrompt: false, prompt: result.prompt, promptResult: result });
      if (result.unreadable.length > 0) {
        set({
          notice: `${result.unreadable.length} document(s) could not be read and are not in the prompt.`,
        });
      }
    } catch (error) {
      set({ buildingPrompt: false, error: message(error) });
    }
  },

  clearNotice: () => set({ notice: null }),

  setProgress: (progress) => set({ convertProgress: progress }),

  setIndexProgress: (progress) => set({ indexProgress: progress }),
}));

/**
 * Wire the main process's progress events into the store.
 *
 * Called once from `App` and guarded by a module-level flag: React 18 mounts
 * effects twice in development StrictMode, and a second subscription would
 * apply every progress tick twice — harmless for a progress bar, but the
 * pattern is wrong and it hides the next event that is not idempotent.
 */
let subscribed = false

export function subscribeResearchProgress(): () => void {
  if (subscribed) return () => {}
  subscribed = true
  const offConvert = window.AnythingButProPlan.onResearchConvertProgress(
    (progress) => useResearchStore.getState().setProgress(progress),
  )
  const offIndex = window.AnythingButProPlan.onResearchIndexProgress(
    (progress) => useResearchStore.getState().setIndexProgress(progress),
  )
  return () => {
    offConvert()
    offIndex()
    subscribed = false
  }
}