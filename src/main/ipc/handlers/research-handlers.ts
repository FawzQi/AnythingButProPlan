import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  ConversionMode,
  ConvertProgress,
  ConvertRequest,
  ConvertResult,
  ExtractionEngine,
  IndexBuildProgress,
  IndexBuildRequest,
  IndexBuildResult,
  ResearchCancelRequest,
  ResearchPromptRequest,
  ResearchPromptResult,
  ResearchScanResult,
} from "@shared/types";
import {
  ensureGitignore,
  scanDocuments,
} from "../../services/research/document-scanner";
import { convertDocuments } from "../../services/research/document-converter";
import { buildIndex } from "../../services/research/research-index";
import { buildResearchPrompt } from "../../services/research/research-prompt";
import { clearCancel, requestCancel } from "../../services/core/cancellation";
import {
  optionalString,
  requireString,
  requireVisionProvider,
} from "../validation";

export function registerResearchHandlers(): void {
  ipcMain.handle(
    IpcChannel.ResearchScan,
    async (_event, root: unknown): Promise<ResearchScanResult> => {
      const projectRoot = requireString(root, "projectRoot");
      const scan = await scanDocuments(projectRoot);
      if (scan.docsDirExists || scan.sourceDir === "root") {
        try {
          await ensureGitignore(projectRoot);
        } catch (error) {
          console.warn("Could not update .gitignore:", String(error));
        }
      }
      return scan;
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchConvert,
    async (event, request: unknown): Promise<ConvertResult> => {
      const typed = request as ConvertRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const mode: ConversionMode =
        typed?.mode === "text-images" ? "text-images" : "text";
      const engine: ExtractionEngine =
        typed?.engine === "fast" ? "fast" : "auto";
      const visionProvider = requireVisionProvider(typed?.visionProvider);

      clearCancel(projectRoot);
      const sender = event.sender;
      return convertDocuments({
        projectRoot,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        mode,
        engine,
        visionProviderId: visionProvider,
        onProgress: (progress: ConvertProgress) => {
          if (!sender.isDestroyed()) {
            sender.send(IpcChannel.ResearchConvertProgress, progress);
          }
        },
      });
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchBuildIndex,
    async (event, request: unknown): Promise<IndexBuildResult> => {
      const typed = request as IndexBuildRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      clearCancel(projectRoot);
      const sender = event.sender;
      const result = await buildIndex({
        projectRoot,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        onProgress: (progress: IndexBuildProgress) => {
          if (!sender.isDestroyed()) {
            sender.send(IpcChannel.ResearchIndexProgress, progress);
          }
        },
      });
      return { index: result.index, skipped: result.skipped };
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchBuildPrompt,
    async (_event, request: unknown): Promise<ResearchPromptResult> => {
      const typed = request as ResearchPromptRequest;
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const mode = typed?.mode === "rag" ? "rag" : "full";
      const topK = typed?.topK;
      if (
        topK !== undefined &&
        (!Number.isInteger(topK) || topK < 1 || topK > 50)
      ) {
        throw new Error(`topK must be an integer between 1 and 50.`);
      }
      return buildResearchPrompt({
        projectRoot,
        mode,
        docPaths: (typed?.docPaths ?? []).map((p) =>
          requireString(p, "document path"),
        ),
        question: optionalString(typed?.question, "question"),
        topK,
        rerank: typed?.rerank === true,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.ResearchCancel,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as ResearchCancelRequest;
      requestCancel(requireString(typed?.projectRoot, "projectRoot"));
    },
  );
}
