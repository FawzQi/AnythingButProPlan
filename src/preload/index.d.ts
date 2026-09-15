import type { LARPGentApi } from "./index";

declare global {
  interface Window {
    LARPGent: LARPGentApi;
  }
}

export {};
