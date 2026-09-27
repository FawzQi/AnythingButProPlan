import type { AnythingButProPlanApi } from "./index";

declare global {
  interface Window {
    AnythingButProPlan: AnythingButProPlanApi;
  }
}

export {};
