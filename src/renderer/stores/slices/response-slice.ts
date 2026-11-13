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
  debugRunning: false,
  debugResults: null,
  debugLog: "",
  debugActiveCommandIndex: null,
  debugAutoRun: false,

  setDebugAutoRun: (enabled) => {
    set({ debugAutoRun: enabled });
    get().setNotice(
      enabled
        ? "Debug commands will run without asking. Turn this off when you are done."
        : "Debug commands will ask for confirmation again.",
    );
  },

  setResponse: async (raw) => {
    set({ rawResponse: raw, applyResults: null, error: null });
    // A research answer is prose and citations, not files. Running the coding
    // parser over it would surface every quoted passage as an edit candidate
    // and offer to write it to disk. The mode is read here rather than passed
    // in because the textarea is shared: one paste handler, two meanings.
    if (raw.trim() === "" || get().aiSettings?.mode === "research") {
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

  runDebugCommands: async () => {
    const { projectRoot, parseResult, debugRunning, debugAutoRun } = get();
    if (!projectRoot || !parseResult || debugRunning) return;
    const commands = parseResult.debugCommands ?? [];
    if (commands.length === 0) return;

    // `===Debug===` content comes from the model, so running it is executing
    // arbitrary shell locally. The dialog shows every command verbatim and is
    // skipped only after the user has explicitly opted in with the toggle.
    if (!debugAutoRun) {
      const preview = commands.map((cmd) => `  ${cmd}`).join("\n");
      const confirmed = await window.AnythingButProPlan.confirmDialog({
        message: `Run ${commands.length} command(s) in the project directory?`,
        detail: `${preview}\n\nThese commands run with your user account's permissions.`,
        confirmLabel: "Run commands",
        tone: "warning",
      });
      if (!confirmed) {
        get().setNotice("Debug commands were not run.");
        return;
      }
    }

    set({
      debugRunning: true,
      debugResults: null,
      debugLog: "",
      debugActiveCommandIndex: 0,
      error: null,
    });

    const unsubscribe = window.AnythingButProPlan.onDebugProgress((event) => {
      if (event.type === "start" && event.commandIndex !== undefined) {
        set({
          debugActiveCommandIndex: event.commandIndex,
          debugLog:
            (get().debugLog ? get().debugLog + "\n" : "") +
            `$ ${event.command}\n`,
        });
      } else if (event.type === "chunk" && event.chunk) {
        set({ debugLog: get().debugLog + event.chunk });
      } else if (event.type === "finish") {
        set({
          debugLog:
            get().debugLog +
            (get().debugLog.endsWith("\n") ? "" : "\n") +
            `[Exit code: ${event.exitCode}]\n`,
        });
      }
    });

    try {
      const response = await window.AnythingButProPlan.runDebugCommands({
        projectRoot,
        commands,
      });

      set({
        debugRunning: false,
        debugResults: response.results,
        debugLog: response.aggregatedLog,
        debugActiveCommandIndex: null,
      });

      if (response.aggregatedLog) {
        await window.AnythingButProPlan.copyText(response.aggregatedLog);
      }

      get().setNotice(
        response.success
          ? "All debug commands passed. Output copied to monitor and clipboard."
          : "Debug commands finished with errors. Output copied to monitor and clipboard.",
      );
    } catch (err) {
      set({ debugRunning: false, error: toErrorMessage(err) });
    } finally {
      unsubscribe();
    }
  },

  killDebugCommands: async () => {
    try {
      await window.AnythingButProPlan.killDebugCommands();
      set({ debugRunning: false, debugActiveCommandIndex: null });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  clearDebug: () => {
    set({
      debugRunning: false,
      debugResults: null,
      debugLog: "",
      debugActiveCommandIndex: null,
    });
  },
});
