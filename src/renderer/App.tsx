import { useEffect } from "react";
import type { ReactElement } from "react";
import { useAppStore } from "./stores/app-store";
import { FileTree } from "./components/FileTree";
import { PromptDashboard } from "./components/PromptDashboard";
import { ResponsePanel } from "./components/ResponsePanel";
import { useResizableWidth } from "./lib/hooks";
import { Banner, ResizeHandle } from "./lib/ui";

export default function App(): ReactElement {
  const notice = useAppStore((state) => state.notice);
  const error = useAppStore((state) => state.error);
  const clearNotice = useAppStore((state) => state.clearNotice);

  // Left panel: the divider sits to its right, so dragging right grows it.
  const fileTree = useResizableWidth(370, { min: 180, max: 640, sign: 1 });
  // Right panel: the divider sits to its left, so dragging right shrinks it.
  const response = useResizableWidth(560, { min: 320, max: 960, sign: -1 });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[#2c3038] px-3 py-2">
        <h1 className="text-sm font-semibold text-slate-100">LARPGent</h1>
        <span className="text-xs text-slate-500">codebase → prompt → code</span>
        <div className="ml-auto flex items-center gap-2">
          {notice ? (
            <span className="text-xs text-emerald-400">{notice}</span>
          ) : null}
          {error ? (
            <div className="max-w-[520px]">
              <Banner tone="error">{error}</Banner>
            </div>
          ) : null}
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <FileTree width={fileTree.width} />
        <ResizeHandle
          onMouseDown={fileTree.onMouseDown}
          label="Resize project panel"
        />
        <PromptDashboard />
        <ResizeHandle
          onMouseDown={response.onMouseDown}
          label="Resize response panel"
        />
        <ResponsePanel width={response.width} />
      </main>
    </div>
  );
}
