import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useAppStore } from "../stores/app-store";
import { Button } from "../lib/ui";

const COMPACT = "px-2 py-0.5 text-xs";

/**
 * Dropdown that lists the folders the user has opened, most-recently-used
 * first. Lives next to the "Open folder" button in both the coding-mode
 * FileTree and the research-mode DocumentTree, since both share the same
 * project-root picker in the app store.
 *
 * The list is populated automatically — every successful open (via the
 * picker or via this menu) calls `recentFoldersAdd` on the main process, so
 * there is no separate "save this folder" step. `recentFoldersList` prunes
 * entries whose path no longer exists on disk, so a stale shortcut never
 * produces an error banner.
 *
 * The trigger is disabled while the settings are still loading so the
 * count in the label does not flicker from 0 to N on first render.
 */
export function RecentFoldersMenu(): ReactElement {
  const recentFolders = useAppStore((state) => state.recentFolders);
  const loading = useAppStore((state) => state.recentFoldersLoading);
  const currentRoot = useAppStore((state) => state.projectRoot);
  const openProjectByPath = useAppStore((state) => state.openProjectByPath);
  const removeRecent = useAppStore((state) => state.removeRecentFolder);
  const clearRecent = useAppStore((state) => state.clearRecentFolders);
  const loadRecent = useAppStore((state) => state.loadRecentFolders);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // One-shot load on mount. `openProjectByPath` keeps the store in sync
  // after every subsequent open, so no polling is needed.
  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // Close on outside click / Escape. Registered only while the menu is
  // open so the listeners do not exist during normal use.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        className={COMPACT}
        disabled={loading}
        onClick={() => setOpen((value) => !value)}
        title="Open a recently-used folder"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {recentFolders.length > 0
          ? `Recent (${recentFolders.length}) ▾`
          : "Recent ▾"}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 max-h-80 w-80 overflow-auto rounded border border-[#2c3038] bg-[#1e2127] shadow-lg"
        >
          {recentFolders.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-slate-500">
              No saved folders yet. Open one and it will appear here.
            </p>
          ) : (
            <>
              <ul className="py-1">
                {recentFolders.map((folder) => {
                  const isCurrent = folder.path === currentRoot;
                  return (
                    <li
                      key={folder.path}
                      className="group flex items-center gap-1 px-1"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpen(false);
                          void openProjectByPath(folder.path);
                        }}
                        className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs transition ${
                          isCurrent
                            ? "bg-sky-950/40 text-sky-100"
                            : "text-slate-300 hover:bg-[#2a2f38]"
                        }`}
                        title={folder.path}
                      >
                        <span className="block truncate font-medium">
                          {folder.label}
                          {isCurrent ? (
                            <span className="ml-1 text-[10px] text-sky-400">
                              (current)
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-slate-500">
                          {folder.path}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeRecent(folder.path)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 transition-opacity hover:bg-red-900/40 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                        title="Remove from list"
                        aria-label={`Remove ${folder.path} from list`}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-end border-t border-[#2c3038] px-2 py-1">
                <button
                  type="button"
                  onClick={() => void clearRecent()}
                  className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-red-900/40 hover:text-red-300"
                >
                  Clear all
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}