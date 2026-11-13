/**
 * Minimal fixture repository description for the eval harness.
 *
 * A fixture is a set of files plus a verification command and a scripted model
 * policy. It runs the real `SessionEngine` against a real temp directory, so
 * what the harness measures is the shipping loop, not a mock of it.
 */
export interface FixtureFile {
  path: string;
  content: string;
}

export interface EvalTask {
  name: string;
  /** Instruction the session is created with. */
  task: string;
  /** Files that make up the starting repository. */
  files: FixtureFile[];
  /**
   * Command that exits 0 when the task is solved. The harness uses it as the
   * verification stage, so "turns to green" is measured by a real process.
   */
  verifyCommand: string;
  /**
   * The scripted model. Receives the turn number and the prompt, returns the
   * response text. A policy that never converges models a weak chat model; one
   * that fixes it on turn 2 models a strong one.
   */
  respond: (turn: number, prompt: string, files: Map<string, string>) => string;
  /** Hard stop so a non-converging policy cannot loop forever. */
  maxTurns?: number;
  /** Expected outcome for a task that must fail, used for negative cases. */
  expectFailure?: boolean;
}
