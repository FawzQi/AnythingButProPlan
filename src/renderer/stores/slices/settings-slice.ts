import type { StateCreator } from "zustand";
import { toErrorMessage } from "@shared/utils/errors";
import type { AppStoreState, SettingsSlice } from "./types";

export const createSettingsSlice: StateCreator<
  AppStoreState,
  [],
  [],
  SettingsSlice
> = (set) => ({
  aiProviders: [],
  aiSettings: null,
  aiSettingsLoading: false,
  aiModelsByProvider: {},
  aiModelsLoading: false,
  notice: null,
  error: null,

  loadAiSettings: async () => {
    set({ aiSettingsLoading: true });
    try {
      const result = await window.AnythingButProPlan.aiGetSettings();
      set({
        aiProviders: result.providers,
        aiSettings: result.settings,
        aiSettingsLoading: false,
      });
    } catch (error) {
      set({ aiSettingsLoading: false, error: toErrorMessage(error) });
    }
  },

  saveAiSettings: async (request) => {
    try {
      const settings = await window.AnythingButProPlan.aiSaveSettings(request);
      set({ aiSettings: settings, notice: "AI settings saved." });
    } catch (error) {
      set({ error: toErrorMessage(error) });
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
      set({ aiModelsLoading: false });
      console.warn("Failed to list models:", toErrorMessage(error));
    }
  },

  setNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),
});
