/**
 * Process-wide registry for active sessions.
 *
 * One engine per project at a time. The renderer drives the copy-paste loop in
 * two explicit IPC calls (`build-turn`, then `submit`), so no long-lived
 * promise has to survive a renderer reload — which is exactly what makes the
 * clipboard path robust.
 */
import type {
  Session,
  SessionCreateRequest,
  SessionProgressEvent,
  SessionSubmitResult,
  TurnPrompt,
} from "@shared/types";
import { findActiveSession, loadSession, saveSession } from "./session-store";
import { SessionEngine, newSession, type SessionEngineOptions } from "./session-engine";
import { ClipboardExecutor } from "./executors/clipboard";

interface ActiveSession {
  engine: SessionEngine;
  projectRoot: string;
}

const active = new Map<string, ActiveSession>();


/**
 * Build a fresh engine for a session. The executor is clipboard-only here: the
 * renderer supplies responses through `submit`, and the API executor is
 * constructed separately by the unattended path.
 */
function createEngine(
  options: SessionEngineOptions,
): { engine: SessionEngine; clipboard: ClipboardExecutor } {
  const clipboard = new ClipboardExecutor(() => {
    // The renderer already has the prompt; this callback exists for parity with
    // the API executor, where emission is the action.
  });
  const engine = new SessionEngine(clipboard, options);
  return { engine, clipboard };
}

export function getActiveEngine(projectRoot: string): SessionEngine | null {
  return active.get(projectRoot)?.engine ?? null;
}

function register(session: Session, options: SessionEngineOptions): SessionEngine {
  const { engine } = createEngine(options);
  active.set(session.projectRoot, { engine, projectRoot: session.projectRoot });
  return engine;
}

export interface CreateArgs extends SessionCreateRequest {
  verificationCommands?: SessionEngineOptions["verificationCommands"];
  maxTurns?: number;
  onProgress?: (event: SessionProgressEvent) => void;
}

export async function createSession(args: CreateArgs): Promise<{ session: Session; prompt: TurnPrompt }> {
  const session = newSession(args);
  const engine = register(session, {
    verificationCommands: args.verificationCommands,
    maxTurns: args.maxTurns,
    onProgress: args.onProgress,
  });
  const prompt = await engine.start(session);
  return { session: engine.session ?? session, prompt };
}

export async function resumeSession(
  projectRoot: string,
  id: string,
  options: SessionEngineOptions,
): Promise<Session | null> {
  const session = await loadSession(projectRoot, id);
  if (session === null) return null;
  const engine = register(session, options);
  await engine.start(session);
  return engine.session ?? session;
}

export async function getOrResumeActive(
  projectRoot: string,
  options: SessionEngineOptions,
): Promise<{ session: Session; prompt: TurnPrompt } | null> {
  const existing = active.get(projectRoot);
  if (existing !== undefined) {
    const session = existing.engine.session;
    const prompt = existing.engine.prompt;
    if (session !== null && prompt !== null) return { session, prompt };
    if (session !== null) {
      const next = await existing.engine.start(session);
      return { session: existing.engine.session ?? session, prompt: next };
    }
  }

  const stored = await findActiveSession(projectRoot);
  if (stored === null) return null;
  const engine = register(stored, options);
  const prompt = await engine.start(stored);
  return { session: engine.session ?? stored, prompt };
}

export async function submitResponse(
  projectRoot: string,
  sessionId: string,
  response: string,
  options: SessionEngineOptions,
): Promise<SessionSubmitResult> {
  let entry = active.get(projectRoot);
  if (entry === undefined || entry.engine.session?.id !== sessionId) {
    const session = await loadSession(projectRoot, sessionId);
    if (session === null) throw new Error(`Session ${sessionId} not found.`);
    const engine = register(session, options);
    if (engine.prompt === null) await engine.start(session);
    entry = { engine, projectRoot };
  }

  const result = await entry.engine.submit(response);
  return result;
}

export function cancelSession(projectRoot: string): void {
  active.get(projectRoot)?.engine.cancel();
}

export async function updateSessionPlan(
  projectRoot: string,
  sessionId: string,
  plan: Session["plan"],
): Promise<Session> {
  const session = await loadSession(projectRoot, sessionId);
  if (session === null) throw new Error(`Session ${sessionId} not found.`);
  session.plan = plan;
  session.updatedAt = Date.now();
  await saveSession(session);
  return session;
}

/** Drop the in-memory engine for a project (after delete or project switch). */
export function forgetProject(projectRoot: string): void {
  active.delete(projectRoot);
}
