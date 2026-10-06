import type { StateCreator } from "zustand";
import type { FileNode } from "@shared/types";
import { toErrorMessage } from "@shared/utils/errors";
import { collectSelectedPaths } from "../../lib/tree";
import { insertCustomPrompt } from "../../lib/prompt";
import type { AppStoreState, PromptSlice } from "./types";

export const createPromptSlice: StateCreator<
  AppStoreState,
  [],
  [],
  PromptSlice
> = (set, get) => ({
  prompt: "",
  tokenCount: 0,
  promptFileCount: 0,
  unreadable: [],
  sensitiveFiles: [],
  building: false,
  customPrompt: "",
  mapTokenCount: null,
  aiSuggesting: false,
  aiLastSuggestion: null,

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
      console.warn("Failed to calculate map tokens:", toErrorMessage(error));
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
        ...(suggestion.method === "gitnexus-only" ||
        suggestion.method === "gitnexus-jev" ||
        suggestion.method === "gitnexus-llm"
          ? {}
          : { mapTokenCount: suggestion.mapTokens }),
      });

      const chosen = new Set(suggestion.paths);
      const apply = (node: FileNode): FileNode => {
        if (node.type === "file") {
          return { ...node, selected: chosen.has(node.path) };
        }
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
      set({ aiSuggesting: false, error: toErrorMessage(error) });
    }
  },

  buildPrompt: async () => {
    const { projectRoot, tree } = get();
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
      set({ building: false, error: toErrorMessage(error) });
    }
  },

  clearPrompt: () => {
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
});
