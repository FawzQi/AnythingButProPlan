/**
 * Eval fixtures.
 *
 * Each fixture is a tiny realistic repository plus a scripted model policy.
 * The point is not to test the scripted text — it is to measure the loop:
 *
 *   - **turns-to-green**: how many round trips until verification passes
 *   - **regression rate**: how often a turn had to be rolled back
 *   - **files touched**: precision against the set the task actually needs
 *   - **repair rate**: how often a guard caught a malformed response
 *
 * The policies below are deliberately of three strengths: one that fixes the
 * problem immediately, one that needs the failure log from turn 1 to fix it on
 * turn 2, and one that never converges. A loop that only "works" with the
 * first policy is not a loop.
 */
import type { EvalTask } from "./types";

function fileEntry(path: string, content: string): string {
  return `File: ${path}\n\`\`\`\n${content}\n\`\`\``;
}

function response(files: { path: string; content: string }[], plan: string[] = []): string {
  return [
    ...(plan.length > 0 ? ["===Plan===", ...plan, "======"] : []),
    "===Files===",
    ...files.map((file) => fileEntry(file.path, file.content)),
    "======",
    "===Explanation===",
    "Done.",
    "======",
    "===Debug===",
    "None",
    "======",
  ].join("\n");
}

const retrySource = `export function retry<T>(fn: () => T): T {
  return fn();
}
`;

const retryTest = `import { retry } from "../src/retry";

let attempts = 0;
const value = retry(() => {
  attempts += 1;
  if (attempts < 3) throw new Error("transient");
  return "ok";
});

if (value !== "ok") throw new Error("retry did not recover");
if (attempts !== 3) throw new Error("expected 3 attempts, got " + attempts);
`;

export const retryTask: EvalTask = {
  name: "retry-recovers",
  task: "Make `retry` call the function until it stops throwing, up to 3 attempts.",
  files: [
    { path: "src/retry.ts", content: retrySource },
    { path: "tests/retry.test.ts", content: retryTest },
    { path: "README.md", content: "# Fixture\n" },
  ],
  verifyCommand: "npx --yes tsx tests/retry.test.ts",
  respond: () =>
    response([
      {
        path: "src/retry.ts",
        content: `export function retry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
      },
    ]),
};

export const retryNeedsSecondTurn: EvalTask = {
  name: "retry-needs-failure-log",
  task: "Make `retry` recover from transient failures.",
  files: [
    { path: "src/retry.ts", content: retrySource },
    { path: "tests/retry.test.ts", content: retryTest },
  ],
  verifyCommand: "npx --yes tsx tests/retry.test.ts",
  // Turn 1 is a plausible but wrong attempt; the policy only produces the
  // correct one once it has seen the failing output, which is what a real chat
  // model does too.
  respond: (turn) =>
    turn === 1
      ? response([
          {
            path: "src/retry.ts",
            content: `export function retry<T>(fn: () => T): T {
  return fn();
}
`,
          },
        ])
      : response([
          {
            path: "src/retry.ts",
            content: `export function retry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
          },
        ]),
};

export const neverConverges: EvalTask = {
  name: "never-converges",
  task: "Make `retry` recover from transient failures.",
  files: [
    { path: "src/retry.ts", content: retrySource },
    { path: "tests/retry.test.ts", content: retryTest },
  ],
  verifyCommand: "npx --yes tsx tests/retry.test.ts",
  respond: () => response([{ path: "src/retry.ts", content: retrySource }]),
  maxTurns: 3,
  expectFailure: true,
};

export const truncationRepaired: EvalTask = {
  name: "truncation-repaired",
  task: "Make `retry` recover from transient failures.",
  files: [
    { path: "src/retry.ts", content: retrySource },
    { path: "tests/retry.test.ts", content: retryTest },
  ],
  verifyCommand: "npx --yes tsx tests/retry.test.ts",
  respond: (turn) =>
    turn === 1
      ? // Deliberately truncated: no closing fence, half a file.
        ["===Files===", "File: src/retry.ts", "```ts", "export function retry<T>(fn: () => T): T {"].join(
          "\n",
        )
      : response([
          {
            path: "src/retry.ts",
            content: `export function retry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
          },
        ]),
};

export const allTasks: EvalTask[] = [
  retryTask,
  retryNeedsSecondTurn,
  truncationRepaired,
  neverConverges,
];
