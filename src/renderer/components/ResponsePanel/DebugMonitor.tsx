import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../lib/ui";

interface DebugMonitorProps {
  onClose: () => void;
}

export function DebugMonitor({ onClose }: DebugMonitorProps): ReactElement {
  const debugRunning = useAppStore((state) => state.debugRunning);
  const debugResults = useAppStore((state) => state.debugResults);
  const debugLog = useAppStore((state) => state.debugLog);
  const killDebugCommands = useAppStore((state) => state.killDebugCommands);
  const clearDebug = useAppStore((state) => state.clearDebug);

  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom as new log chunks stream in
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [debugLog]);

  const handleCopy = async (): Promise<void> => {
    if (!debugLog) return;
    await window.AnythingButProPlan.copyText(debugLog);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const allPassed =
    debugResults &&
    debugResults.length > 0 &&
    debugResults.every((r) => r.status === "success");

  const hasFailed =
    debugResults && debugResults.some((r) => r.status === "failed");

  return (
    <div className="flex flex-col rounded border border-[#2c3038] bg-[#16181d] text-xs">
      <header className="flex shrink-0 items-center justify-between border-b border-[#2c3038] px-3 py-1.5 bg-[#12141a]">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-wide text-slate-300">
            Debug Monitor
          </span>
          {debugRunning ? (
            <span className="inline-flex items-center gap-1.5 text-sky-400">
              <span className="inline-block size-2 animate-ping rounded-full bg-sky-400" />
              <span>Running commands…</span>
            </span>
          ) : allPassed ? (
            <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-800/50">
              ✓ All passed
            </span>
          ) : hasFailed ? (
            <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] font-medium text-red-300 border border-red-800/50">
              ✕ Failed
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {debugRunning ? (
            <button
              type="button"
              onClick={() => void killDebugCommands()}
              className="rounded bg-red-900/60 hover:bg-red-800 text-red-200 px-2 py-0.5 text-[11px] font-medium transition cursor-pointer"
            >
              Kill
            </button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => void handleCopy()}
            disabled={!debugLog}
            title="Copy all debug logs to clipboard"
          >
            {copied ? "Copied!" : "Copy Log"}
          </Button>
          <Button
            variant="ghost"
            onClick={clearDebug}
            disabled={!debugLog && !debugResults}
            title="Clear the monitor log"
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            title="Close the debug monitor view"
          >
            Close
          </Button>
        </div>
      </header>

      <pre
        ref={outputRef}
        className="max-h-72 min-h-36 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap select-text bg-[#0f1115]"
      >
        {debugLog ? (
          debugLog
        ) : (
          <span className="italic text-slate-500">
            {debugRunning
              ? "Running debug command..."
              : "No debug logs yet. Run debug commands to view output here."}
          </span>
        )}
      </pre>

      {debugResults && debugResults.length > 0 ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-[#2c3038] px-3 py-1.5 text-[11px] text-slate-400 bg-[#12141a]">
          {debugResults.map((res, i) => (
            <span
              key={i}
              className={`rounded px-1.5 py-0.5 font-mono ${
                res.status === "success"
                  ? "bg-emerald-950/60 text-emerald-300 border border-emerald-900/40"
                  : "bg-red-950/60 text-red-300 border border-red-900/40"
              }`}
            >
              $ {res.command} (exit {res.exitCode}, {res.durationMs}ms)
            </span>
          ))}
        </footer>
      ) : null}
    </div>
  );
}
