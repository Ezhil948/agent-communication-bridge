import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WIN_DRIVE_URI_RE = /^file:\/\/\/[a-zA-Z](?:%3A|:)[/\\]/;
const WIN_DRIVE_PATH_RE = /^[a-zA-Z]:\//;

/**
 * Convert a `file://` workspace or file URI into a filesystem path.
 * Preserves POSIX test paths like `file:///home/u/proj` even when evaluated on Windows,
 * while decoding Windows drive URIs like `file:///c%3A/Users/...` via `fileURLToPath`.
 */
export function fileUriToFsPath(uriOrPath: string): string {
  if (!uriOrPath.startsWith("file://")) return uriOrPath;
  if (process.platform !== "win32" || WIN_DRIVE_URI_RE.test(uriOrPath)) {
    try {
      return fileURLToPath(uriOrPath);
    } catch {
      // Fall through to best-effort decode below
    }
  }
  const stripped = uriOrPath.replace(/^file:\/\//, "");
  try {
    const decoded = decodeURIComponent(stripped);
    return /^\/[a-zA-Z]:[/\\]/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return stripped;
  }
}

/**
 * Normalize a filesystem path (or `file://` URI) into a canonical comparison/hash key:
 * forward slashes, no redundant separators or trailing slashes, and lowercase on Windows paths.
 */
export function normalizePathKey(input: string): string {
  let path = fileUriToFsPath(input).trim().replace(/\\/g, "/");
  if (path.startsWith("//")) {
    path = `//${path.slice(2).replace(/\/+/g, "/")}`;
  } else {
    path = path.replace(/\/+/g, "/");
  }
  if (path.length > 1 && !/^[a-zA-Z]:\/$/.test(path)) {
    path = path.replace(/\/+$/, "");
  }
  if (process.platform === "win32" || WIN_DRIVE_PATH_RE.test(path)) {
    path = path.toLowerCase();
  }
  return path;
}

/** Resolve relative paths against cwd and return a canonical comparison/hash key. */
export function resolvePathKey(input: string): string {
  if (input.startsWith("file://")) return normalizePathKey(input);
  return normalizePathKey(resolve(input));
}

/** True when two filesystem paths or `file://` URIs point to the same location. */
export function pathsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return normalizePathKey(a) === normalizePathKey(b);
}

/**
 * True when `target` is inside (or equal to) `root`.
 * Safely rejects `..` traversal AND cross-drive Windows escapes (`D:\...` vs `C:\...`).
 */
export function isSubpath(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return false;
  return !isAbsolute(rel);
}

