import { useMemo } from "react";
import type { ReactElement } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { useAppStore } from "../../stores/app-store";
import { useElementSize } from "../../lib/hooks";
import { flattenTree, type TreeRow } from "../../lib/tree";
import { Button, Panel } from "../../lib/ui";

const ROW_HEIGHT = 24;

// Compact overrides so the header's five controls fit inside the panel.
// The base Button padding is meant for roomier contexts.
const COMPACT = "px-2 py-0.5 text-xs";

interface RowData {
  rows: TreeRow[];
  onToggle: (id: string, selected: boolean) => void;
  onExpand: (id: string) => void;
  onOpenFile: (path: string) => void;
}

function Row({
  index,
  style,
  data,
}: ListChildComponentProps<RowData>): ReactElement {
  const { rows, onToggle, onExpand, onOpenFile } = data;
  const row = rows[index];
  if (!row) return <div style={style} />;
  const { node, depth } = row;
  const isDirectory = node.type === "directory";

  return (
    <div
      style={{ ...style, paddingLeft: 8 + depth * 14 }}
      className="flex items-center gap-1.5 pr-2 text-sm hover:bg-[#23262d]"
      title={isDirectory ? node.path : `${node.path} (double-click to open)`}
      onDoubleClick={() => {
        // Directory double-clicks fall through to the expand chevron; only
        // files open in the editor. Guarding here keeps the row's click
        // behaviour identical for directories.
        if (!isDirectory) onOpenFile(node.path);
      }}
    >
      {isDirectory ? (
        <button
          type="button"
          onClick={() => onExpand(node.id)}
          className="w-3 shrink-0 text-slate-400 hover:text-slate-100"
          aria-label={node.expanded ? "Collapse" : "Expand"}
        >
          {node.expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}

      <input
        type="checkbox"
        checked={node.selected}
        onChange={(event) => onToggle(node.id, event.target.checked)}
        className="size-3.5 shrink-0 accent-sky-500"
      />

      <span
        className={`truncate ${isDirectory ? "font-medium text-slate-300" : "text-slate-400"}`}
      >
        {node.name}
      </span>
    </div>
  );
}

export function FileTree({ width }: { width: number }): ReactElement {
  const tree = useAppStore((state) => state.tree);
  const projectRoot = useAppStore((state) => state.projectRoot);
  const scanning = useAppStore((state) => state.scanning);
  const openProject = useAppStore((state) => state.openProject);
  const refreshProject = useAppStore((state) => state.refreshProject);
  const openTerminal = useAppStore((state) => state.openTerminal);
  const toggleNode = useAppStore((state) => state.toggleNode);
  const toggleExpanded = useAppStore((state) => state.toggleExpanded);
  const selectAll = useAppStore((state) => state.selectAll);
  const openFileForEdit = useAppStore((state) => state.openFileForEdit);

  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const rows = useMemo(() => (tree ? flattenTree(tree) : []), [tree]);

  const itemData = useMemo<RowData>(
    () => ({
      rows,
      onToggle: toggleNode,
      onExpand: toggleExpanded,
      onOpenFile: (path) => void openFileForEdit(path),
    }),
    [rows, toggleNode, toggleExpanded, openFileForEdit],
  );

  return (
    <Panel
      title="Project"
      className="shrink-0 border-r"
      style={{ width }}
      actions={
        <>
          <Button
            variant="ghost"
            className={COMPACT}
            onClick={() => selectAll(true)}
            disabled={!tree}
            title="Select all files"
          >
            All
          </Button>
          <Button
            variant="ghost"
            className={COMPACT}
            onClick={() => selectAll(false)}
            disabled={!tree}
            title="Deselect all files"
          >
            None
          </Button>
          <Button
            variant="ghost"
            className={COMPACT}
            onClick={() => void refreshProject()}
            disabled={!projectRoot || scanning}
            title={
              projectRoot ? "Re-scan the opened folder" : "Open a folder first"
            }
            aria-label="Refresh project tree"
          >
            {scanning ? "…" : "↻"}
          </Button>
          <Button
            variant="ghost"
            className={COMPACT}
            onClick={() => void openTerminal()}
            disabled={!projectRoot}
            title={
              projectRoot
                ? `Open a terminal at ${projectRoot}`
                : "Open a folder first"
            }
            aria-label="Open terminal at project root"
          >
            &gt;_
          </Button>
          <Button
            variant="primary"
            className={COMPACT}
            onClick={() => void openProject()}
            disabled={scanning}
            title="Open a different project folder"
          >
            {scanning ? "Scanning…" : "Open folder"}
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col">
        <div className="truncate border-b border-[#2c3038] px-3 py-1.5 text-xs text-slate-500">
          {projectRoot ?? "No folder opened"}
        </div>
        <div ref={containerRef} className="min-h-0 flex-1">
          {rows.length > 0 && size.height > 0 ? (
            <FixedSizeList<RowData>
              height={size.height}
              width={size.width}
              itemCount={rows.length}
              itemSize={ROW_HEIGHT}
              itemData={itemData}
            >
              {Row}
            </FixedSizeList>
          ) : (
            <p className="p-3 text-xs text-slate-500">
              {tree
                ? "No promptable files found."
                : "Open a project folder to begin."}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
