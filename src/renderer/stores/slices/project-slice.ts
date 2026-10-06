import type { StateCreator } from "zustand";
import type { FileNode } from "@shared/types";
import { toErrorMessage } from "@shared/utils/errors";
import {
  collectSelectedPaths,
  setSubtreeSelected,
  updateNode,
} from "../../lib/tree";
import type { AppStoreState, ProjectSlice } from "./types";

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

export const createProjectSlice: StateCreator<
  AppStoreState,
  [],
  [],
  ProjectSlice
> = (set, get) => ({
  projectRoot: null,
  tree: null,
  fileCount: 0,
  scanning: false,
  recentFolders: [],
  recentFoldersLoading: false,

  loadRecentFolders: async () => {
    set({ recentFoldersLoading: true });
    try {
      const folders = await window.AnythingButProPlan.recentFoldersList();
      set({ recentFolders: folders, recentFoldersLoading: false });
    } catch (error) {
      set({ recentFoldersLoading: false });
      console.warn("Failed to load recent folders:", toErrorMessage(error));
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
        editingPath: null,
        editingContent: "",
        editingOriginal: "",
        gitStatus: undefined,
        gitCommitMessage: "",
        mapTokenCount: null,
      });

      try {
        const folders = await window.AnythingButProPlan.recentFoldersAdd(
          scan.root,
        );
        set({ recentFolders: folders });
      } catch (error) {
        console.warn("Failed to save recent folder:", toErrorMessage(error));
      }
      await get().refreshGitStatus();
      await get().calculateMapTokens();
    } catch (error) {
      set({ scanning: false, error: toErrorMessage(error) });
    }
  },

  removeRecentFolder: async (path) => {
    try {
      const folders = await window.AnythingButProPlan.recentFoldersRemove(path);
      set({ recentFolders: folders });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  clearRecentFolders: async () => {
    try {
      const folders = await window.AnythingButProPlan.recentFoldersClear();
      set({ recentFolders: folders });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  openProject: async () => {
    try {
      const root = await window.AnythingButProPlan.pickDirectory();
      if (!root) return;
      await get().openProjectByPath(root);
    } catch (error) {
      set({ scanning: false, error: toErrorMessage(error) });
    }
  },

  refreshProject: async () => {
    const { projectRoot, tree } = get();
    if (!projectRoot) return;
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
      await get().refreshGitStatus();
      await get().calculateMapTokens();
    } catch (error) {
      set({ scanning: false, error: toErrorMessage(error) });
    }
  },

  openTerminal: async () => {
    const projectRoot = get().projectRoot;
    if (!projectRoot) return;
    try {
      await window.AnythingButProPlan.openTerminal(projectRoot);
    } catch (error) {
      set({ error: toErrorMessage(error) });
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
});
