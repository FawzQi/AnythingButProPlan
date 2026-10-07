/**
 * Cooperative cancellation for the long research jobs.
 *
 * A conversion and an index build are the only operations in the app that
 * run for minutes, and both are loops over work that cannot be interrupted
 * halfway: a converter subprocess killed mid-extraction leaves a truncated
 * markdown file, and an embedding batch cannot be resumed from its middle.
 * So neither is force-killed. The loop checks this flag at each iteration
 * boundary, finishes the unit of work in flight, writes what it has, and
 * returns a partial result. A cancelled conversion therefore keeps every
 * document it already finished — which is the behaviour a user pressing
 * Cancel at document 7 of 20 expects.
 *
 * The flag is keyed by project root, not by job: one project converts its
 * documents one at a time, and a job started later clears the flag left by
 * an earlier cancel. The consequence is that cancelling an index build while
 * a conversion is running would also stop the conversion. That case cannot
 * be reached from the UI (the Index tab's buttons are disabled while a
 * conversion runs), so the flag is not per-job-type.
 *
 * ponytail: one flag per project. Split into per-job keys if the UI ever
 * allows two research jobs to run at once.
 */
const cancelled = new Set<string>()

export function requestCancel(projectRoot: string): void {
  cancelled.add(projectRoot)
}

export function clearCancel(projectRoot: string): void {
  cancelled.delete(projectRoot)
}

export function isCancelled(projectRoot: string): boolean {
  return cancelled.has(projectRoot)
}
