import type { StateCreator } from "zustand";
import type {
  PlanStep,
  Session,
  SessionProgressEvent,
  SessionSummary,
  TurnPrompt,
} from "@shared/types";
import { toErrorMessage } from "@shared/utils/errors";
import type { AppStoreState } from "./types";

export interface SessionSlice {
  /** The session currently open in the panel, or null. */
  session: Session | null;
  /** The prompt waiting to be sent to the web chat, or null. */
  sessionPrompt: TurnPrompt | null;
  sessionSummaries: SessionSummary[];
  sessionBusy: boolean;
  sessionProgress: SessionProgressEvent | null;
  /** Human-readable notice from the last turn (applied / rejected / rolled back). */
  sessionNotice: string | null;

  setSessionProgress: (event: SessionProgressEvent | null) => void;

  createSession: (task: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  refreshSessionList: () => Promise<void>;
  submitSessionResponse: (response: string) => Promise<void>;
  cancelSession: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  togglePlanStep: (stepId: string) => Promise<void>;
  rollbackTurn: (checkpointId: string) => Promise<void>;
  clearSessionNotice: () => void;
}

/**
 * Verification commands used by the session loop.
 *
 * The app cannot guess a project's scripts reliably, and running the wrong
 * command is worse than running none, so this stays empty until the user sets
 * it. With no commands the loop still applies and reports; it simply does not
 * claim to have verified anything.
 */
function verificationCommands(): { command: string; stage: "test" }[] {
  return [];
}

export const createSessionSlice: StateCreator<
  AppStoreState,
  [],
  [],
  SessionSlice
> = (set, get) => ({
  session: null,
  sessionPrompt: null,
  sessionSummaries: [],
  sessionBusy: false,
  sessionProgress: null,
  sessionNotice: null,

  clearSessionNotice: () => set({ sessionNotice: null }),

  setSessionProgress: (event) => set({ sessionProgress: event }),

  refreshSessionList: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      const summaries = await window.AnythingButProPlan.listSessions({ projectRoot });
      set({ sessionSummaries: summaries });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  createSession: async (task: string) => {
    const { projectRoot } = get();
    if (!projectRoot) {
      set({ error: "Open a project before starting a session." });
      return;
    }
    if (task.trim() === "") {
      set({ error: "Describe the task before starting a session." });
      return;
    }

    set({ sessionBusy: true, error: null, sessionNotice: null });
    try {
      const { session, prompt } = await window.AnythingButProPlan.createSession({
        projectRoot,
        task,
        verificationCommands: verificationCommands(),
      });
      set({ session, sessionPrompt: prompt });
      await get().refreshSessionList();
    } catch (err) {
      set({ error: toErrorMessage(err) });
    } finally {
      set({ sessionBusy: false });
    }
  },

  loadSession: async (sessionId: string) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    set({ sessionBusy: true, error: null });
    try {
      const active = await window.AnythingButProPlan.getActiveSession({ projectRoot });
      if (active !== null && active.session.id === sessionId) {
        set({ session: active.session, sessionPrompt: active.prompt });
        return;
      }
      const session = await window.AnythingButProPlan.getSession({ projectRoot, sessionId });
      set({ session, sessionPrompt: null });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    } finally {
      set({ sessionBusy: false });
    }
  },

  submitSessionResponse: async (response: string) => {
    const { projectRoot, session } = get();
    if (!projectRoot || session === null) return;
    if (response.trim() === "") {
      set({ error: "Paste the chat's reply before submitting." });
      return;
    }

    set({ sessionBusy: true, error: null, sessionNotice: null });
    try {
      const result = await window.AnythingButProPlan.submitSessionResponse({
        projectRoot,
        sessionId: session.id,
        response,
      });
      const turn = result.session.turns[result.session.turns.length - 1];
      set({
        session: result.session,
        sessionPrompt: result.nextTurn,
        sessionNotice: describeTurn(turn),
      });
      await get().refreshSessionList();
    } catch (err) {
      set({ error: toErrorMessage(err) });
    } finally {
      set({ sessionBusy: false });
    }
  },

  cancelSession: async () => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      await window.AnythingButProPlan.cancelSession({ projectRoot });
      set({ sessionBusy: false, sessionProgress: null });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  deleteSession: async (sessionId: string) => {
    const { projectRoot, session } = get();
    if (!projectRoot) return;
    try {
      await window.AnythingButProPlan.deleteSession({ projectRoot, sessionId });
      if (session?.id === sessionId) {
        set({ session: null, sessionPrompt: null });
      }
      await get().refreshSessionList();
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  togglePlanStep: async (stepId: string) => {
    const { projectRoot, session } = get();
    if (!projectRoot || session === null) return;

    const cycle: Record<PlanStep["status"], PlanStep["status"]> = {
      pending: "active",
      active: "done",
      done: "pending",
      blocked: "pending",
    };
    const plan = session.plan.map((step) =>
      step.id === stepId ? { ...step, status: cycle[step.status] } : step,
    );

    try {
      const updated = await window.AnythingButProPlan.updateSessionPlan({
        projectRoot,
        sessionId: session.id,
        plan,
      });
      set({ session: updated });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  rollbackTurn: async (checkpointId: string) => {
    const { projectRoot } = get();
    if (!projectRoot) return;
    try {
      const result = await window.AnythingButProPlan.rollbackSessionTurn({
        projectRoot,
        checkpointId,
      });
      set({
        sessionNotice: result.ok
          ? "Turn rolled back."
          : `Rollback reported: ${result.errors.join("; ")}`,
      });
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },
});

function describeTurn(turn: Session["turns"][number] | undefined): string | null {
  if (turn === undefined) return null;
  switch (turn.outcome) {
    case "applied": {
      const count = turn.applied?.filter((r) => r.status !== "failed").length ?? 0;
      return `Applied ${count} file change(s).`;
    }
    case "needed-context":
      return `The model asked for ${turn.parsed?.needs.length ?? 0} file(s); the next prompt includes them.`;
    case "no-op":
      return "The response contained no file changes.";
    case "rejected":
      return "The response was refused by a safety guard. A repair prompt is ready.";
    case "regressed":
      return `Turn rolled back: ${turn.regression ?? "verification got worse."}`;
    case "failed":
      return "Changes applied but verification still fails. The next prompt includes the errors.";
    default:
      return null;
  }
}
