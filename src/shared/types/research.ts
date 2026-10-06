import type { AiProviderId } from "./ai";

export type ConversionMode = "text" | "text-images";

export type DocumentStatus = "ready" | "converted" | "failed";

export interface DocumentEntry {
  /** Path relative to `docs/`, POSIX separators. */
  path: string;
  /** Flat directory name under `converted/` for this document. */
  slug: string;
  sizeBytes: number;
  status: DocumentStatus;
  /** Present once a conversion has run. */
  mode?: ConversionMode;
  convertedAt?: number;
  /** True when the vision pass completed for this document. */
  imageAnalyzed?: boolean;
  /** Provider used for the vision pass. */
  visionProvider?: AiProviderId;
  /** Chunks this document contributed to the last index build. */
  chunkCount?: number;
  /** Failure reason from the last attempt. */
  error?: string;
  /** True when the converted markdown is on disk. */
  convertedExists: boolean;
}

/** State of the retrieval index, read from `.index/meta.json`. */
export interface IndexStatus {
  built: boolean;
  documentCount: number;
  chunkCount: number;
  dimensions: number;
  /** Embedding model the vectors were produced with. */
  model: string | null;
  builtAt: number | null;
}

export interface ResearchScanResult {
  /** True when `<project_root>/docs` exists. */
  docsDirExists: boolean;
  sourceDir: "docs" | "root";
  documents: DocumentEntry[];
  index: IndexStatus;
}

export type ExtractionEngine = "auto" | "fast";

export interface ConvertRequest {
  projectRoot: string;
  /** `docs/`-relative paths to convert. Empty means "every document". */
  docPaths: string[];
  mode: ConversionMode;
  /** Extractor to run. Defaults to `auto`. */
  engine?: ExtractionEngine;
  /** Vision provider for `text-images`. Ignored for `text`. */
  visionProvider?: AiProviderId;
}

/** One progress tick per stage per document. */
export interface ConvertProgress {
  path: string;
  /** 1-based position of this document in the batch. */
  index: number;
  total: number;
  stage: "extracting" | "images" | "saving";
  message: string;
}

export interface ConvertResult {
  documents: DocumentEntry[];
  failed: { path: string; error: string }[];
  /** True when the user cancelled before the batch finished. */
  cancelled: boolean;
}

export interface IndexBuildRequest {
  projectRoot: string;
  /** Documents to index. Empty means "every converted document". */
  docPaths: string[];
}

export interface IndexBuildProgress {
  stage: "chunking" | "embedding" | "saving";
  done: number;
  total: number;
  message: string;
}

export interface IndexBuildResult {
  index: IndexStatus;
  /** Documents skipped because they have no converted markdown yet. */
  skipped: string[];
}

export type ResearchPromptMode = "full" | "rag";

export interface ResearchPromptRequest {
  projectRoot: string;
  mode: ResearchPromptMode;
  /** Documents to include. Empty means "every converted document". */
  docPaths: string[];
  /** Required for `rag`. */
  question?: string;
  /** Excerpts kept after retrieval. Defaults to 8. */
  topK?: number;
  rerank?: boolean;
}

export interface ResearchCitation {
  document: string;
  heading: string;
}

export interface ResearchPromptResult {
  prompt: string;
  tokenCount: number;
  documentCount: number;
  /** Excerpts included. Zero for `full`. */
  chunkCount: number;
  /** Titles of the documents that went in, in prompt order. */
  documents: string[];
  citations: ResearchCitation[];
  /** Documents that could not be read. */
  unreadable: string[];
}

export interface ResearchCancelRequest {
  projectRoot: string;
}
