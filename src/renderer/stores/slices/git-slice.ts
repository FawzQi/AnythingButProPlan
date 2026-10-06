import type { StateCreator } from "zustand";
import { toErrorMessage } from "@shared/utils/errors";
import type { AppStoreState, GitSlice } from "./types";

export const createGitSlice: StateCreator<AppStoreState, [], [], GitSlice> = (
  set,
  get,
) => ({
  gitStatus: undefined,
  gitStatusLoading: false,
  gitBusy: false,
  gitCommitMessage: "",

  refreshGitStatus: async () => {
    const { projectRoot } = get();
    if (!projectRoot) {
      set({ gitStatus: null, gitStatusLoading: false });
      return;
    }
    set({ gitStatusLoading: true, error: null });
    try {
      const status = await window.AnythingButProPlan.gitStatus(projectRoot);
      if (get().projectRoot !== projectRoot) return;
      set({ gitStatus: status, gitStatusLoading: false });
    } catch (error) {
      if (get().projectRoot !== projectRoot) return;
      set({
        gitStatus: null,
        gitStatusLoading: false,
        error: toErrorMessage(error),
      });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
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
      set({ gitBusy: false, error: toErrorMessage(error) });
    }
  },

  setGitCommitMessage: (message) => set({ gitCommitMessage: message }),
});
