import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  GitCommitRequest,
  GitCommitResult,
  GitDiffContent,
  GitDiffRequest,
  GitDiscardRequest,
  GitInitRequest,
  GitInitResult,
  GitStageRequest,
  GitStatus,
  GitUnstageRequest,
} from "@shared/types";
import {
  commitChanges,
  discardAllFiles,
  discardFile,
  getDiffContent,
  getStatus,
  initRepository,
  stageAllFiles,
  stageFile,
  unstageFile,
} from "../../services/git/git-service";
import { deleteFile } from "../../services/core/fs-service";
import { requireString } from "../validation";

export function registerGitHandlers(): void {
  ipcMain.handle(
    IpcChannel.GitStatus,
    async (_event, root: unknown): Promise<GitStatus | null> => {
      return getStatus(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitInit,
    async (_event, request: unknown): Promise<GitInitResult> => {
      const typed = request as GitInitRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      return initRepository(root);
    },
  );

  ipcMain.handle(
    IpcChannel.GitStage,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitStageRequest;
      await stageFile(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitStageAll,
    async (_event, root: unknown): Promise<void> => {
      await stageAllFiles(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitUnstage,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitUnstageRequest;
      await unstageFile(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiscard,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as GitDiscardRequest;
      const root = requireString(typed?.projectRoot, "projectRoot");
      const relativePath = requireString(typed?.path, "path");
      if (typed?.untracked === true) {
        await deleteFile(root, relativePath);
      } else {
        await discardFile(root, relativePath);
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiscardAll,
    async (_event, root: unknown): Promise<void> => {
      await discardAllFiles(requireString(root, "root"));
    },
  );

  ipcMain.handle(
    IpcChannel.GitCommit,
    async (_event, request: unknown): Promise<GitCommitResult> => {
      const typed = request as GitCommitRequest;
      return commitChanges(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.message, "message"),
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiff,
    async (_event, request: unknown): Promise<GitDiffContent> => {
      const typed = request as GitDiffRequest;
      return getDiffContent(
        requireString(typed?.projectRoot, "projectRoot"),
        requireString(typed?.path, "path"),
        typed?.staged === true,
      );
    },
  );
}
