import type { StateCreator } from "zustand";
import type { ApplyFileInput } from "@shared/types";
import { toErrorMessage } from "@shared/utils/errors";
import type { AppStoreState, ResponseSlice } from "./types";
import { parsedFileKey } from "./types";

export const createResponseSlice: StateCreator<
  AppStoreState,
  [],
  [],
  ResponseSlice
> = (set, get) => ({
  rawResponse: "",
  parseResult: null,
  includes: {},
  applyResults: null,
  applying: false,

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
      set({ error: toErrorMessage(error) });
    }
  },

  setParsedPath: (index, path) => {
    const parseResult = get().parseResult;
    if (!parseResult) return;
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
      await get().refreshGitStatus();
    } catch (error) {
      set({ applying: false, error: toErrorMessage(error) });
    }
  },
});
