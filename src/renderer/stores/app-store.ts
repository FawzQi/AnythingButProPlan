import { create } from "zustand";
import { createProjectSlice } from "./slices/project-slice";
import { createPromptSlice } from "./slices/prompt-slice";
import { createResponseSlice } from "./slices/response-slice";
import { createEditorSlice } from "./slices/editor-slice";
import { createGitSlice } from "./slices/git-slice";
import { createSettingsSlice } from "./slices/settings-slice";
import type { AppStoreState, EditorTab } from "./slices/types";
import { parsedFileKey } from "./slices/types";

export { parsedFileKey };
export type { EditorTab, AppStoreState };
export type AppState = AppStoreState;

export const useAppStore = create<AppStoreState>()((...a) => ({
  ...createProjectSlice(...a),
  ...createPromptSlice(...a),
  ...createResponseSlice(...a),
  ...createEditorSlice(...a),
  ...createGitSlice(...a),
  ...createSettingsSlice(...a),
}));