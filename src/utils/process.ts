import {
  type ChildProcess,
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  spawn,
  type SpawnOptions,
} from "node:child_process";

export interface ResolvedExecutable {
  command: string;
  isCmdScript: boolean;
}

const resolvedCache = new Map<string, ResolvedExecutable>();

/** Clear cached executable lookups (primarily for tests). */
export function clearExecutableCache(): void {
  resolvedCache.clear();
}

/**
 * Resolve a CLI binary name safely across platforms.
 * On Windows, prefers `.exe`/`.com` over `.cmd`/`.bat` from `where` so bare names
 * like `codex` or `agy` resolve to invocable binaries instead of failing with ENOENT/EINVAL.
 */
export function resolveExecutable(command: string): ResolvedExecutable {
  if (process.platform !== "win32") {
    return { command, isCmdScript: false };
  }
  const hasPathSep = command.includes("\\") || command.includes("/");
  if (hasPathSep || /\.(exe|com)$/i.test(command)) {
    return { command, isCmdScript: /\.(cmd|bat)$/i.test(command) };
  }
  if (/\.(cmd|bat)$/i.test(command)) {
    return { command, isCmdScript: true };
  }

  const cached = resolvedCache.get(command);
  if (cached) return cached;

  let resolved: ResolvedExecutable = { command, isCmdScript: false };
  try {
    const out = execFileSync("where", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const candidates = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const exe = candidates.find((c) => /\.(exe|com)$/i.test(c));
    if (exe) {
      resolved = { command: exe, isCmdScript: false };
    } else {
      const cmd = candidates.find((c) => /\.(cmd|bat)$/i.test(c));
      if (cmd) {
        resolved = { command: cmd, isCmdScript: true };
      } else if (candidates[0]) {
        resolved = { command: candidates[0], isCmdScript: false };
      }
    }
  } catch {
    // Keep bare command name if `where` did not find it
  }

  resolvedCache.set(command, resolved);
  return resolved;
}

function quoteCmdArg(arg: string): string {
  // Strip CR/LF to prevent splitting extra cmd.exe lines when invoking a .cmd shim.
  const safe = arg.replace(/[\r\n]/g, " ");
  if (safe.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildCmdShimInvocation(command: string, args: readonly string[]): { file: string; args: string[] } {
  const comspec = process.env.ComSpec || "cmd.exe";
  const inner = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${inner}"`] };
}

/** Execute a CLI binary synchronously, handling Windows `.cmd`/`.bat` shims cleanly. */
export function execBinarySync(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execBinarySync(
  command: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
): Buffer | string;
export function execBinarySync(
  command: string,
  args: readonly string[] = [],
  options: ExecFileSyncOptions = {},
): Buffer | string {
  const resolved = resolveExecutable(command);
  if (resolved.isCmdScript) {
    const cmd = buildCmdShimInvocation(resolved.command, args);
    return execFileSync(cmd.file, cmd.args, {
      windowsHide: true,
      ...options,
      windowsVerbatimArguments: true,
    } as ExecFileSyncOptions);
  }
  return execFileSync(resolved.command, [...args], options);
}

/** Spawn a CLI binary asynchronously, handling Windows `.cmd`/`.bat` shims cleanly. */
export function spawnBinary(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const resolved = resolveExecutable(command);
  if (resolved.isCmdScript) {
    const cmd = buildCmdShimInvocation(resolved.command, args);
    return spawn(cmd.file, cmd.args, {
      windowsVerbatimArguments: true,
      windowsHide: true,
      ...options,
    });
  }
  return spawn(resolved.command, [...args], options);
}

/**
 * Terminate a process (and on Windows its entire descendant tree via `taskkill /T /F`)
 * so stopping a `.cmd`-wrapped child like `codex` never leaves orphaned child processes.
 */
export function killProcessTree(
  target: ChildProcess | number | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      // Process may have already exited
    }
    if (typeof target !== "number" && target && !target.killed) {
      try {
        target.kill();
      } catch {
        // Ignore
      }
    }
    return;
  }

  try {
    if (typeof target !== "number" && target) {
      target.kill(signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // Process may have already exited
  }
}

/**
 * True if an OS process with `pid` is currently alive (`EPERM` means alive under
 * another user; `ESRCH` or invalid PID returns false).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
