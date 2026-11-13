import { registerFileHandlers } from "./handlers/file-handlers";
import { registerDialogHandlers } from "./handlers/dialog-handlers";
import { registerGitHandlers } from "./handlers/git-handlers";
import { registerPromptHandlers } from "./handlers/prompt-handlers";
import { registerAiHandlers } from "./handlers/ai-handlers";
import { registerResearchHandlers } from "./handlers/research-handlers";
import { registerSettingsHandlers } from "./handlers/settings-handlers";
import { registerDebugHandlers } from "./handlers/debug-handlers";
import { registerSessionHandlers } from "./handlers/session-handlers";

/**
 * Register all IPC handlers across domain modules.
 * Every handler validates its inputs at the IPC boundary.
 */
export function registerIpcHandlers(): void {
  registerFileHandlers();
  registerDialogHandlers();
  registerGitHandlers();
  registerPromptHandlers();
  registerAiHandlers();
  registerResearchHandlers();
  registerSettingsHandlers();
  registerDebugHandlers();
  registerSessionHandlers();
}
