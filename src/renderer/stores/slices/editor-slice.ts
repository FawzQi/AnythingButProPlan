import type { StateCreator } from "zustand";
import { toErrorMessage } from "@shared/utils/errors";
import type { AppStoreState, EditorSlice } from "./types";

export const createEditorSlice: StateCreator<
  AppStoreState,
  [],
  [],
  EditorSlice
> = (set, get) => ({
  editorTab: "prompt",
  editingPath: null,
  editingContent: "",
  editingOriginal: "",
  editingLoading: false,
  saving: false,
  deletingPath: null,

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
        error: toErrorMessage(error),
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
      set({ saving: false, error: toErrorMessage(error) });
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
      set({ deletingPath: null, error: toErrorMessage(error) });
    }
  },
});
