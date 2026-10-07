import type { AiProviderId, AppMode } from '../types';

export const TIMEOUTS = {
  /** Outbound provider HTTP requests (net.fetch) */
  HTTP_MS: 60_000,
  /** TypeSafe (Jev) subprocess call timeout */
  JEV_MS: 45_000,
  /** Python helper scripts (e.g. pdftext, pypdfium2) */
  PYTHON_MS: 180_000,
  /** Deep document conversion tools (Docling) */
  DOCLING_MS: 600_000,
  /** Vision model image analysis */
  IMAGE_ANALYSIS_MS: 120_000,
} as const;

export const LIMITS = {
  /** Maximum entries preserved in recent folders list */
  MAX_RECENT_FOLDERS: 10,
  /** Maximum bytes for inlining full documents into research prompt */
  MAX_FULL_DOCUMENT_BYTES: 400_000,
  /** Maximum candidate chunks returned by RAG retriever */
  RETRIEVER_CANDIDATE_LIMIT: 30,
  /** Maximum candidate files considered during GitNexus suggestion */
  GITNEXUS_CANDIDATE_LIMIT: 60,
  /** Shallow byte prefix read to check file relevancy */
  SHALLOW_READ_BYTES: 16_384,
  /** Preceding lines examined when matching markdown context */
  PRECEDING_WINDOW: 6,
} as const;

export const DEFAULTS = {
  /** Default vision provider fallback */
  VISION_PROVIDER: 'deepseek' as AiProviderId,
  /** Default application mode on first launch */
  APP_MODE: 'coding' as AppMode,
} as const;
