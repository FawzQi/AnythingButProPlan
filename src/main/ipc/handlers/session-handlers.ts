import { ipcMain } from "electron";
import { IpcChannel } from "@shared/ipc-channels";
import type {
  PlanStep,
  Session,
  SessionCreateRequest,
  SessionProgressEvent,
  SessionSubmitRequest,
  SessionSubmitResult,
  SessionSummary,
  TurnPrompt,
} from "@shared/types";
import { requireString } from "../validation";
import {
  createSession,
  cancelSession,
  getOrResumeActive,
  submitResponse,
  updateSessionPlan,
  type CreateArgs,
} from "../../services/session/session-registry";
import {
  deleteSession,
  listSessions,
  loadSession,
} from "../../services/session/session-store";
import type { VerificationCommand } from "../../services/session/verification";
import { rollbackGitCheckpointDetailed } from "../../services/git/git-checkpoint";

/** Verification stages the app knows how to run, in order. */
function readCommands(value: unknown): VerificationCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: VerificationCommand[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { command?: unknown; stage?: unknown };
    if (typeof candidate.command !== "string" || candidate.command.trim() === "") continue;
    const stage =
      candidate.stage === "typecheck" ||
      candidate.stage === "lint" ||
      candidate.stage === "test" ||
      candidate.stage === "custom"
        ? candidate.stage
        : "custom";
    commands.push({ command: candidate.command.trim(), stage });
  }
  return commands;
}

function readPlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry, index) => ({
      id: typeof entry.id === "string" ? entry.id : `step-${index + 1}`,
      text: typeof entry.text === "string" ? entry.text : "",
      status: (entry.status === "done" || entry.status === "active" || entry.status === "blocked"
        ? entry.status
        : "pending") as PlanStep["status"],
    }))
    .filter((step) => step.text !== "");
}

function optionsFor(sender: Electron.WebContents, commands: VerificationCommand[]) {
  return {
    verificationCommands: commands,
    onProgress: (event: SessionProgressEvent): void => {
      if (!sender.isDestroyed()) sender.send(IpcChannel.SessionProgress, event);
    },
  };
}

export function registerSessionHandlers(): void {
  ipcMain.handle(
    IpcChannel.SessionCreate,
    async (event, request: unknown): Promise<{ session: Session; prompt: TurnPrompt }> => {
      const typed = request as SessionCreateRequest & { verificationCommands?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const task = requireString(typed?.task, "task");
      const commands = readCommands(typed?.verificationCommands);
      const args: CreateArgs = {
        projectRoot,
        task,
        contextBudget: typeof typed?.contextBudget === "number" ? typed.contextBudget : undefined,
        verificationCommands: commands,
        onProgress: optionsFor(event.sender, commands).onProgress,
      };
      return createSession(args);
    },
  );

  ipcMain.handle(
    IpcChannel.SessionGet,
    async (_event, request: unknown): Promise<Session | null> => {
      const typed = request as { projectRoot?: unknown; sessionId?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const sessionId = requireString(typed?.sessionId, "sessionId");
      return loadSession(projectRoot, sessionId);
    },
  );

  ipcMain.handle(
    IpcChannel.SessionList,
    async (_event, request: unknown): Promise<SessionSummary[]> => {
      const typed = request as { projectRoot?: unknown };
      return listSessions(requireString(typed?.projectRoot, "projectRoot"));
    },
  );

  ipcMain.handle(
    IpcChannel.SessionActive,
    async (event, request: unknown): Promise<{ session: Session; prompt: TurnPrompt } | null> => {
      const typed = request as { projectRoot?: unknown; verificationCommands?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const commands = readCommands(typed?.verificationCommands);
      return getOrResumeActive(projectRoot, optionsFor(event.sender, commands));
    },
  );

  ipcMain.handle(
    IpcChannel.SessionDelete,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as { projectRoot?: unknown; sessionId?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const sessionId = requireString(typed?.sessionId, "sessionId");
      cancelSession(projectRoot);
      await deleteSession(projectRoot, sessionId);
    },
  );

  ipcMain.handle(
    IpcChannel.SessionSubmit,
    async (event, request: unknown): Promise<SessionSubmitResult> => {
      const typed = request as SessionSubmitRequest & { verificationCommands?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const sessionId = requireString(typed?.sessionId, "sessionId");
      const response = typeof typed?.response === "string" ? typed.response : "";
      if (response.trim() === "") {
        throw new Error("Invalid response: paste the chat's reply before submitting.");
      }
      const commands = readCommands(typed?.verificationCommands);
      return submitResponse(projectRoot, sessionId, response, optionsFor(event.sender, commands));
    },
  );

  ipcMain.handle(
    IpcChannel.SessionCancel,
    async (_event, request: unknown): Promise<void> => {
      const typed = request as { projectRoot?: unknown };
      cancelSession(requireString(typed?.projectRoot, "projectRoot"));
    },
  );

  ipcMain.handle(
    IpcChannel.SessionUpdatePlan,
    async (_event, request: unknown): Promise<Session> => {
      const typed = request as { projectRoot?: unknown; sessionId?: unknown; plan?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const sessionId = requireString(typed?.sessionId, "sessionId");
      return updateSessionPlan(projectRoot, sessionId, readPlan(typed?.plan));
    },
  );

  ipcMain.handle(
    IpcChannel.SessionRollbackTurn,
    async (_event, request: unknown): Promise<{ ok: boolean; errors: string[] }> => {
      const typed = request as { projectRoot?: unknown; checkpointId?: unknown };
      const projectRoot = requireString(typed?.projectRoot, "projectRoot");
      const checkpointId = requireString(typed?.checkpointId, "checkpointId");
      const report = await rollbackGitCheckpointDetailed(projectRoot, checkpointId);
      return { ok: report.ok, errors: report.errors };
    },
  );
}
