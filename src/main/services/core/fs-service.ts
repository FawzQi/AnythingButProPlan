import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileNode, ScanResult } from "@shared/types";

/** Directories that are never worth prompting over. */
const ALWAYS_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  "venv",
  ".venv",
  "target",
  "bin",
  "obj",
  ".next",
  ".cache",
]);

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".avif",
  ".tiff",
  ".svgz",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".lib",
  ".class",
  ".pyc",
  ".pyo",
  ".wasm",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".psd",
  ".ai",
  ".sketch",
  ".blend",
  ".lockb",
  ".webm",
]);

/**
 * Legacy `.bak` files written by earlier versions of the app, before Git
 * source control replaced the backup system. They are still hidden from the
 * tree — showing them would clutter the list and cause "Select all" to pull
 * them into a prompt — but the app no longer writes, reads, or cleans them.
 */
const LEGACY_BACKUP_FILE = /\.bak(?:\.[0-9T]+)?$/i;

/**
 * Files whose names routinely carry secrets: API keys, private keys, cloud
 * credentials, package-registry tokens. They remain visible in the tree —
 * silently hiding them would make a project look incomplete and would push
 * users to a terminal to find them — but the tree marks them and the prompt
 * build reports them so the user always knows what is about to be pasted
 * into a chat UI.
 *
 * The name-side match is specific (`.env`, `id_rsa`, …) and the extension-
 * side match is broad (`*.pem`, `*.key`, …). Template variants like
 * `.env.example` and `secrets.sample.toml` are excluded: they describe the
 * shape of a secret, not the secret itself, and they are exactly the kind
 * of file users legitimately want to send to the AI.
 */
const SENSITIVE_FILE_NAME =
  /^(?:\.env(?:\.[a-zA-Z0-9_-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.?_?netrc|\.(?:npmrc|pypirc|pgpass|htpasswd|git-credentials)|credentials\.json|service-account[\w.-]*\.json)$/i;
const SENSITIVE_FILE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i;
const SAFE_TEMPLATE_NAME =
  /\.(?:example|sample|template|dist|defaults)(?:\.[a-z0-9]+)*$/i;

export function isSensitiveFileName(name: string): boolean {
  if (SAFE_TEMPLATE_NAME.test(name)) return false;
  return SENSITIVE_FILE_NAME.test(name) || SENSITIVE_FILE_EXTENSION.test(name);
}

export function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Turn a project-relative path into an absolute one, refusing anything that
 * escapes the project root. Every write and every read of AI-supplied paths
 * funnels through here — this is the single traversal guard.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new Error(`Illegal path: ${relativePath}`);
  }

  const normalizedRoot = path.resolve(root);
  const absolute = path.resolve(normalizedRoot, relativePath);
  const withSeparator = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (absolute !== normalizedRoot && !absolute.startsWith(withSeparator)) {
    throw new Error(`Path escapes the project root: ${relativePath}`);
  }

  // Reject rather than rewrite: a silently renamed AI path would write the
  // file somewhere the model did not ask for. This catches the names Linux
  // accepts but Windows cannot create (CON, NUL, trailing dots/spaces, `:`).
  // eslint-disable-next-line no-control-regex
  const INVALID_FILENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$|[<>:"/\\|?*\x00-\x1f\x7f]|[\s.]$/i;
  for (const segment of relativePath.split("/")) {
    if (segment === "") continue;
    if (INVALID_FILENAME.test(segment)) {
      throw new Error(`Path is not portable across platforms: ${relativePath}`);
    }
  }

  return absolute;
}

/**
 * One `.gitignore` loaded from disk, together with the project-relative
 * directory it lives in. Gitignore patterns are interpreted relative to
 * their own file's location — a pattern `dist/` in `packages/foo/.gitignore`
 * means `packages/foo/dist/`, not the repository's top-level `dist/` — so
 * each nested file gets its own matcher and its own base path.
 */
interface IgnoreMatcher {
  /** Project-relative POSIX directory holding the .gitignore; '' for root. */
  base: string;
  matcher: Ignore;
}

/**
 * Load `<dir>/.gitignore` if it exists and return a matcher scoped to that
 * directory. A missing file is normal, not an error — most directories have
 * no `.gitignore` of their own.
 */
async function loadGitignoreAt(
  absoluteDir: string,
  base: string,
): Promise<IgnoreMatcher | null> {
  const matcher = ignore();
  try {
    const contents = await fs.readFile(
      path.join(absoluteDir, ".gitignore"),
      "utf8",
    );
    matcher.add(contents);
    return { base, matcher };
  } catch {
    return null;
  }
}

/**
 * True when `posixRelative` is ignored by any of the loaded matchers.
 *
 * Each matcher only governs paths beneath its own base directory, so the
 * path handed to `Ignore.ignores` is recomputed relative to that base.
 * Directories are tested with a trailing slash so directory-only patterns
 * (`build/`) match them, while file-only patterns are not tricked into
 * matching a directory of the same name.
 */
function isIgnored(
  matchers: IgnoreMatcher[],
  posixRelative: string,
  isDirectory: boolean,
): boolean {
  for (const { base, matcher } of matchers) {
    let rel: string;
    if (base === "") {
      rel = posixRelative;
    } else if (posixRelative.startsWith(`${base}/`)) {
      rel = posixRelative.slice(base.length + 1);
    } else {
      continue;
    }
    if (rel === "") continue;
    if (matcher.ignores(isDirectory ? `${rel}/` : rel)) return true;
  }
  return false;
}

export async function isBinaryFile(absolutePath: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase()))
    return true;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, "r");
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await handle?.close();
  }
}

interface WalkState {
  root: string;
  fileCount: number;
  skippedCount: number;
}

async function walk(
  absoluteDir: string,
  relativeDir: string,
  inheritedMatchers: IgnoreMatcher[],
  state: WalkState,
): Promise<FileNode[]> {
  // A `.gitignore` in this directory applies to this directory and every
  // descendant, so it is loaded once here and threaded through the recursion
  // rather than being re-read at every level.
  const ownMatcher = await loadGitignoreAt(absoluteDir, relativeDir);
  const matchers = ownMatcher
    ? [...inheritedMatchers, ownMatcher]
    : inheritedMatchers;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories: FileNode[] = [];
  const files: FileNode[] = [];

  for (const entry of entries) {
    const relative =
      relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    const absolute = path.join(absoluteDir, entry.name);
    const posixRelative = toPosix(relative);

    if (entry.isSymbolicLink()) {
      state.skippedCount += 1;
      continue;
    }

    if (entry.isDirectory()) {
      if (
        ALWAYS_SKIP.has(entry.name) ||
        isIgnored(matchers, posixRelative, true)
      ) {
        state.skippedCount += 1;
        continue;
      }
      const children = await walk(absolute, relative, matchers, state);
      if (children.length === 0) continue;
      directories.push({
        id: posixRelative,
        name: entry.name,
        path: posixRelative,
        type: "directory",
        children,
        selected: false,
        expanded: relativeDir === "",
      });
      continue;
    }

    if (!entry.isFile()) continue;
    if (
      ALWAYS_SKIP.has(entry.name) ||
      isIgnored(matchers, posixRelative, false)
    ) {
      state.skippedCount += 1;
      continue;
    }
    // Legacy backup files from before Git source control. Hidden, but not
    // created or cleaned by this version of the app.
    if (LEGACY_BACKUP_FILE.test(entry.name)) continue;
    if (await isBinaryFile(absolute)) {
      state.skippedCount += 1;
      continue;
    }

    let size: number | undefined;
    try {
      size = (await fs.stat(absolute)).size;
    } catch {
      size = undefined;
    }

    state.fileCount += 1;
    files.push({
      id: posixRelative,
      name: entry.name,
      path: posixRelative,
      type: "file",
      selected: false,
      expanded: false,
      size,
      // Set once here rather than re-derived in the renderer, so every
      // consumer of the tree agrees on what "sensitive" means. `undefined`
      // rather than `false` on the common case keeps the IPC payload small
      // for projects that have no sensitive files at all.
      ...(isSensitiveFileName(entry.name) ? { sensitive: true } : {}),
    });
  }

  const byName = (a: FileNode, b: FileNode): number =>
    a.name.localeCompare(b.name);
  return [...directories.sort(byName), ...files.sort(byName)];
}

/** Recursively scan a project root, honouring .gitignore and the skip list. */
export async function scanDirectory(root: string): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root);
  const state: WalkState = {
    root: absoluteRoot,
    fileCount: 0,
    skippedCount: 0,
  };
  const children = await walk(absoluteRoot, "", [], state);

  return {
    root: absoluteRoot,
    tree: {
      id: "",
      name: path.basename(absoluteRoot) || absoluteRoot,
      path: "",
      type: "directory",
      children,
      selected: false,
      expanded: true,
    },
    fileCount: state.fileCount,
    skippedCount: state.skippedCount,
  };
}

export async function readTextFile(
  root: string,
  relativePath: string,
): Promise<string> {
  return fs.readFile(resolveWithinRoot(root, relativePath), "utf8");
}

export async function fileExists(
  root: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await fs.stat(resolveWithinRoot(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Write an arbitrary file (used for "save prompt as"), creating parents. */
export async function writeFileEnsuringDir(
  absolutePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

export interface WriteOutcome {
  status: "created" | "overwritten" | "skipped";
}

/**
 * Write one project-relative file. Content is written byte-for-byte as
 * given; nothing is normalized. When the on-disk content already matches
 * `content`, the write is a no-op reported as `skipped` — that keeps
 * callers from taking needless follow-up actions (a Git status refresh, a
 * notice banner) when nothing actually changed.
 */
export async function writeFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<WriteOutcome> {
  const absolute = resolveWithinRoot(root, relativePath);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(absolute, "utf8");
  } catch {
    // Nothing on disk yet.
  }

  if (existing === content) {
    return { status: "skipped" };
  }

  await fs.mkdir(path.dirname(absolute), { recursive: true });

  // Prefer temp file + rename so a crash mid-write cannot leave a truncated
  // file. The rename is the fragile half on Windows — `MoveFileEx` with
  // REPLACE_EXISTING is refused with EPERM/EBUSY when the destination is
  // briefly locked by an indexer, an antivirus scan, or another handle that
  // has not yet been released. Since the alternative is losing the user's
  // save entirely, fall back to a direct in-place write whenever either the
  // temp write or the rename fails.
  const temporary = `${absolute}.tmp`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, absolute);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await fs.writeFile(absolute, content, "utf8");
  }

  return { status: existing === null ? "created" : "overwritten" };
}

export interface DeleteOutcome {
  status: "deleted" | "not-found";
}

/**
 * Remove one project-relative file. Returns `not-found` rather than throwing
 * when the target is missing — a delete directive against a file that no
 * longer exists is a no-op, not an error worth failing the whole apply over.
 *
 * Version history is provided by Git source control, not by `.bak` siblings;
 * nothing is preserved here beyond what the user can recover from their own
 * commits.
 */
export async function deleteFile(
  root: string,
  relativePath: string,
): Promise<DeleteOutcome> {
  const absolute = resolveWithinRoot(root, relativePath);
  try {
    await fs.unlink(absolute);
    return { status: "deleted" };
  } catch {
    return { status: "not-found" };
  }
}