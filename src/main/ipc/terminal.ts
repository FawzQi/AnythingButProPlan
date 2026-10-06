import { spawn } from "node:child_process";

/**
 * Launch the platform's terminal emulator in `cwd`. Detached + unref so the
 * child outlives this process — a terminal the user opened should stay open
 * after the app quits.
 */
export function openTerminalAt(cwd: string): void {
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", "cmd", "/K", `cd /d "${cwd}"`];
  } else if (platform === "darwin") {
    command = "open";
    args = ["-a", "Terminal", cwd];
  } else {
    command = "x-terminal-emulator";
    args = [`--working-directory=${cwd}`];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    console.error(`Failed to open terminal at ${cwd}:`, error);
  });
  child.unref();
}
