import { spawn, type ChildProcess } from "node:child_process";
import type {
  DebugCommandResult,
  DebugProgressEvent,
  DebugRunResponse,
} from "@shared/types";

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

let activeProcess: ChildProcess | null = null;
let isCancelled = false;

export function killDebugCommands(): void {
  isCancelled = true;
  if (activeProcess) {
    try {
      if (process.platform !== "win32" && activeProcess.pid) {
        process.kill(-activeProcess.pid, "SIGTERM");
      } else {
        activeProcess.kill("SIGTERM");
      }
    } catch {
      try {
        activeProcess.kill("SIGTERM");
      } catch {
        // Ignored
      }
    }
    activeProcess = null;
  }
}

export async function runDebugCommands(
  projectRoot: string,
  commands: string[],
  onProgress?: (event: DebugProgressEvent) => void,
): Promise<DebugRunResponse> {
  isCancelled = false;
  const results: DebugCommandResult[] = [];
  let aggregatedLog = "";

  if (commands.length === 0) {
    return {
      results: [],
      aggregatedLog: "",
      success: true,
    };
  }

  const MAX_OUTPUT = 1024 * 1024; // 1MB buffer per command

  for (let i = 0; i < commands.length; i++) {
    if (isCancelled) {
      break;
    }

    const cmd = commands[i];
    onProgress?.({
      type: "start",
      commandIndex: i,
      command: cmd,
      totalCommands: commands.length,
    });

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    await new Promise<void>((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        exitCode = code;
        activeProcess = null;
        resolve();
      };

      try {
        const isUnix = process.platform !== "win32";
        const shell = isUnix
          ? process.env.SHELL || "/bin/bash"
          : true;

        const proc = spawn(cmd, {
          cwd: projectRoot,
          shell,
          detached: isUnix,
          env: { ...process.env, FORCE_COLOR: "0" },
        });

        activeProcess = proc;

        // 2-minute safety timeout
        timeoutId = setTimeout(() => {
          if (!settled) {
            stderr += "\n[Process timed out after 120s]";
            try {
              if (isUnix && proc.pid) {
                process.kill(-proc.pid, "SIGTERM");
              } else {
                proc.kill("SIGTERM");
              }
            } catch {
              // Ignored
            }
            finish(124);
          }
        }, 120_000);

        proc.stdout?.on("data", (data: Buffer | string) => {
          const str = data.toString();
          if (stdout.length < MAX_OUTPUT) {
            stdout += str.slice(0, MAX_OUTPUT - stdout.length);
          }
          onProgress?.({
            type: "chunk",
            commandIndex: i,
            chunk: str,
          });
        });

        proc.stderr?.on("data", (data: Buffer | string) => {
          const str = data.toString();
          if (stderr.length < MAX_OUTPUT) {
            stderr += str.slice(0, MAX_OUTPUT - stderr.length);
          }
          onProgress?.({
            type: "chunk",
            commandIndex: i,
            chunk: str,
          });
        });

        proc.on("close", (code) => {
          finish(code ?? 0);
        });

        proc.on("error", (err) => {
          stderr += `\nExecution error: ${err.message}`;
          finish(1);
        });
      } catch (err) {
        stderr += `\nExecution error: ${err instanceof Error ? err.message : String(err)}`;
        finish(1);
      }
    });

    const durationMs = Date.now() - startTime;
    const cleanStdout = stripAnsi(stdout);
    const cleanStderr = stripAnsi(stderr);
    const combinedOutput = (
      cleanStdout + (cleanStderr ? (cleanStdout ? "\n" : "") + cleanStderr : "")
    ).trim();

    const cmdResult: DebugCommandResult = {
      command: cmd,
      stdout: cleanStdout,
      stderr: cleanStderr,
      exitCode,
      durationMs,
      status: exitCode === 0 ? "success" : "failed",
    };
    results.push(cmdResult);

    const logBlock = `$ ${cmd}\n${combinedOutput ? combinedOutput + "\n" : ""}[Exit code: ${exitCode}]\n`;
    aggregatedLog += (aggregatedLog ? "\n" : "") + logBlock;

    onProgress?.({
      type: "finish",
      commandIndex: i,
      command: cmd,
      exitCode,
      chunk: combinedOutput,
    });
  }

  const success =
    results.length > 0 && results.every((r) => r.status === "success");

  onProgress?.({
    type: "done",
    results,
    aggregatedLog,
  });

  return {
    results,
    aggregatedLog,
    success,
  };
}
