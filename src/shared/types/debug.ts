export interface DebugCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  status: "success" | "failed";
}

export interface DebugRunRequest {
  projectRoot: string;
  commands: string[];
}

export interface DebugRunResponse {
  results: DebugCommandResult[];
  aggregatedLog: string;
  success: boolean;
}

export interface DebugProgressEvent {
  type: "start" | "chunk" | "finish" | "done";
  commandIndex?: number;
  command?: string;
  totalCommands?: number;
  chunk?: string;
  exitCode?: number;
  results?: DebugCommandResult[];
  aggregatedLog?: string;
}
