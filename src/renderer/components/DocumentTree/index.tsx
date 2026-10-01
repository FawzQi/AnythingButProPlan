import { useEffect } from "react";
import type { ReactElement } from "react";
import type { DocumentEntry } from "@shared/types";
import { VISION_PROVIDERS } from "@shared/vision-providers";
import { useAppStore } from "../../stores/app-store";
import { useResearchStore } from "../../stores/research-store";
import { Banner, Button, Panel } from "../../lib/ui";
import { RecentFoldersMenu } from "../RecentFoldersMenu";

const COMPACT = "px-2 py-0.5 text-xs";

/**
 * Left panel of research mode: the documents under `docs/`, their conversion
 * status, and the controls that act on them.
 *
 * The status column is the feature's memory. Everything the user needs in
 * order to know what to do next is one of five words: `ready` (never
 * converted), `converted`, `converted + figures`, `failed` (with the reason
 * underneath), or `unsupported` (a format the converter does not read). A
 * green tick with no detail is what makes people re-convert a document they
 * already paid for.
 *
 * Buttons are context-sensitive on purpose: a document that is already
 * converted offers "Re-convert" and "Add figure descriptions" rather than the
 * same "Convert" button, because re-running a conversion costs a Marker pass
 * on the CPU (minutes) and re-running the vision pass costs money.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ document }: { document: DocumentEntry }): ReactElement {
  const label = !document.convertedExists
    ? document.status === "failed"
      ? "failed"
      : "not converted"
    : document.status === "failed"
      ? "failed"
      : document.imageAnalyzed
        ? "converted + figures"
        : "converted";

  const tone = !document.convertedExists
    ? document.status === "failed"
      ? "bg-red-900/40 text-red-300"
      : "bg-[#2a2f38] text-slate-400"
    : document.status === "failed"
      ? "bg-red-900/40 text-red-300"
      : document.imageAnalyzed
        ? "bg-emerald-900/40 text-emerald-300"
        : "bg-sky-900/40 text-sky-300";

  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${tone}`}>
      {label}
    </span>
  );
}

function Row({
  document,
  selected,
  busy,
  onToggle,
  onConvert,
}: {
  document: DocumentEntry;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onConvert: (mode: "text" | "text-images") => void;
}): ReactElement {
  const unsupported = document.status === "failed" && !document.convertedExists;
  return (
    <li className="border-b border-[#23262d] px-3 py-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 size-3.5 shrink-0 accent-sky-500"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${document.path}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
              {document.path}
            </span>
            <StatusBadge document={document} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span>{formatBytes(document.sizeBytes)}</span>
            {document.chunkCount !== undefined ? (
              <span>· {document.chunkCount} chunks indexed</span>
            ) : null}
            {document.mode === "text-images" && document.visionProvider ? (
              <span>· figures via {document.visionProvider}</span>
            ) : null}
            {document.convertedAt !== undefined ? (
              <span>
                · converted{" "}
                {new Date(document.convertedAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>
          {document.error !== undefined ? (
            <p
              className={`mt-1 text-[11px] leading-snug ${
                unsupported ? "text-slate-500" : "text-amber-400"
              }`}
            >
              {document.error}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              className={COMPACT}
              disabled={busy || unsupported}
              onClick={() => onConvert("text")}
              title={
                document.convertedExists
                  ? "Convert again from the original document"
                  : "Extract text to converted/<slug>/"
              }
            >
              {document.convertedExists ? "Re-convert" : "Convert"}
            </Button>
            <Button
              variant="ghost"
              className={COMPACT}
              disabled={busy || unsupported}
              onClick={() => onConvert("text-images")}
              title="Convert and describe every figure with the selected vision provider"
            >
              {document.imageAnalyzed ? "Re-do figures" : "+ figures"}
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

function ProgressBar({ fraction }: { fraction: number }): ReactElement {
  return (
    <div
      className="h-1 w-full overflow-hidden rounded bg-[#2a2f38]"
      role="progressbar"
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-sky-500 transition-[width]"
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`,
        }}
      />
    </div>
  );
}

export function DocumentTree({ width }: { width: number }): ReactElement {
  const projectRoot = useAppStore((state) => state.projectRoot);
  // Same action the coding mode's FileTree uses to open a folder. The
  // header-level Open folder button that used to live in App.tsx is gone,
  // so this is the only control that points the app at a project without
  // leaving research mode. It writes the one shared `projectRoot`, and the
  // effect below re-runs the scan when that changes.
  const openProject = useAppStore((state) => state.openProject);

  const documents = useResearchStore((state) => state.documents);
  const selected = useResearchStore((state) => state.selected);
  const scanning = useResearchStore((state) => state.scanning);
  const converting = useResearchStore((state) => state.converting);
  const progress = useResearchStore((state) => state.convertProgress);
  const conversionMode = useResearchStore((state) => state.conversionMode);
  const engine = useResearchStore((state) => state.engine);
  const visionProvider = useResearchStore((state) => state.visionProvider);
  const sourceDir = useResearchStore((state) => state.sourceDir);
  const refresh = useResearchStore((state) => state.refreshDocuments);
  const toggleSelected = useResearchStore((state) => state.toggleSelected);
  const setSelection = useResearchStore((state) => state.setSelection);
  const setConversionMode = useResearchStore(
    (state) => state.setConversionMode,
  );
  const setEngine = useResearchStore((state) => state.setEngine);
  const setVisionProvider = useResearchStore(
    (state) => state.setVisionProvider,
  );
  const convert = useResearchStore((state) => state.convertDocuments);
  const cancel = useResearchStore((state) => state.cancel);

  useEffect(() => {
    void refresh();
  }, [refresh, projectRoot]);

  /**
   * Open a different folder. Deliberately not awaited inside the click
   * handler beyond the store call itself: the picker is a native modal and
   * the store action resolves after the user has either chosen or
   * dismissed it, at which point the `useEffect` above fires on the new
   * `projectRoot` and re-scans. Doing anything else here would race that
   * effect.
   */
  const openFolder = (): void => {
    void openProject();
  };

  const convertible = documents.filter(
    (document) => document.convertedExists || document.error === undefined,
  );
  const targets =
    selected.length > 0 ? selected : convertible.map((d) => d.path);
  const fraction =
    progress === null ? 0 : (progress.index - 1) / Math.max(1, progress.total);

  const runConvert = (paths: string[], mode: "text" | "text-images"): void => {
    setConversionMode(mode);
    void convert(paths);
  };

  return (
    <Panel
      title="Documents"
      className="shrink-0 border-r"
      style={{ width }}
      actions={
        <>
          <span className="text-[11px] text-slate-500">
            {documents.length} doc(s)
          </span>
          <Button
            variant="ghost"
            className={COMPACT}
            disabled={documents.length === 0 || converting}
            onClick={() => setSelection(documents.map((d) => d.path))}
            title="Select every document"
          >
            All
          </Button>
          <Button
            variant="ghost"
            className={COMPACT}
            disabled={selected.length === 0}
            onClick={() => setSelection([])}
            title="Clear the selection — actions then apply to every document"
          >
            None
          </Button>
          <Button
            variant="ghost"
            className={COMPACT}
            disabled={scanning || converting}
            onClick={() => void refresh()}
            title="Rescan docs/ and converted/"
            aria-label="Rescan documents"
          >
            {scanning ? "…" : "↻"}
          </Button>
          <RecentFoldersMenu />
          <Button
            variant="primary"
            className={COMPACT}
            disabled={converting || scanning}
            onClick={openFolder}
            title="Open a project folder"
          >
            {scanning ? "Scanning…" : "Open folder"}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-[#2c3038] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="primary"
              className={COMPACT}
              disabled={converting || targets.length === 0}
              onClick={() => runConvert(targets, conversionMode)}
            >
              {converting
                ? "Converting…"
                : `Convert ${targets.length} (${conversionMode === "text-images" ? "text + figures" : "text"})`}
            </Button>
            {converting ? (
              <Button
                variant="danger"
                className={COMPACT}
                onClick={() => void cancel()}
                title="Stop after the document in flight finishes"
              >
                Cancel
              </Button>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="size-3.5 accent-sky-500"
                checked={conversionMode === "text-images"}
                disabled={converting}
                onChange={(event) =>
                  setConversionMode(
                    event.target.checked ? "text-images" : "text",
                  )
                }
              />
              describe figures
            </label>
            <select
              className="rounded border border-[#2c3038] bg-[#12141a] px-1 py-0.5 text-[11px] text-slate-300 outline-none disabled:opacity-40"
              value={engine}
              disabled={converting}
              onChange={(event) =>
                setEngine(
                  event.target.value === "fast"
                    ? "fast"
                    : event.target.value === "webchat"
                      ? "webchat"
                      : "auto",
                )
              }
              title="Which extractor converts PDFs. Marker reconstructs layout and figures but takes minutes per paper on CPU; fast uses pdftext and takes seconds, without figures."
            >
              <option value="auto">extractor: Docling (accurate, slow)</option>
              <option value="fast">
                extractor: fast (seconds, no figures)
              </option>
              <option value="webchat">
                extractor: webchat (raw, then rewrite via chat)
              </option>
            </select>
            <select
              className="rounded border border-[#2c3038] bg-[#12141a] px-1 py-0.5 text-[11px] text-slate-300 outline-none disabled:opacity-40"
              value={visionProvider}
              disabled={converting || conversionMode !== "text-images"}
              onChange={(event) =>
                setVisionProvider(event.target.value as typeof visionProvider)
              }
              title="Vision provider for this conversion — recorded per document"
            >
              {VISION_PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {progress !== null ? (
            <div className="mt-2">
              <ProgressBar fraction={fraction} />
              <p className="mt-1 text-[11px] text-slate-400">
                {progress.index}/{progress.total} — {progress.path}:{" "}
                {progress.message}
              </p>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {sourceDir === "root" ? (
            <p className="border-b border-[#23262d] px-3 py-2 text-[11px] leading-snug text-slate-500">
              Reading documents from the project root — there is no{" "}
              <code className="rounded bg-[#2a2f38] px-1">docs/</code> folder.
              Only PDFs, markdown, and text files are listed here; a folder of
              code would otherwise fill this list with unrelated files.
            </p>
          ) : null}
          {documents.length === 0 ? (
            <div className="p-3">
              <Banner tone={sourceDir === "root" ? "warn" : "info"}>
                {sourceDir === "root" ? (
                  <>
                    No <code className="rounded bg-[#2a2f38] px-1">docs/</code>{" "}
                    folder and no PDFs, markdown, or text files in the project
                    root. Put your documents in this folder and press ↻, or
                    create{" "}
                    <code className="rounded bg-[#2a2f38] px-1">docs/</code> to
                    keep them out of the way.
                  </>
                ) : (
                  <>
                    Nothing in{" "}
                    <code className="rounded bg-[#2a2f38] px-1">docs/</code>{" "}
                    yet. Put your PDFs, markdown, or text files inside and press
                    ↻.
                  </>
                )}
              </Banner>
            </div>
          ) : (
            <ul>
              {documents.map((document) => (
                <Row
                  key={document.path}
                  document={document}
                  selected={selected.includes(document.path)}
                  busy={converting}
                  onToggle={() => toggleSelected(document.path)}
                  onConvert={(mode) => runConvert([document.path], mode)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}