import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileUriToFsPath, normalizePathKey } from "../utils/path.js";

const execFileAsync = promisify(execFile);

export interface AncestorProcessCommandEntry {
  pid: number;
  ppid: number;
  name: string;
  commandLine?: string;
  args?: string[];
}

const PLUGIN_INSTALL_PATH_PATTERNS = [
  /\/\.gemini\/(?:antigravity\/)?config\/plugins(?:\/|$)/,
  /\/\.claude\/plugins(?:\/|$)/,
  /\/\.codex\/plugins(?:\/|$)/,
  /\/\.opencode\/plugins?(?:\/|$)/,
];

/**
 * Return true when `dirPath` points inside a global client plugin/extension directory
 * rather than a user's project workspace. Used to avoid registering a shared plugin
 * install folder as the workspace when a host (e.g. Antigravity) spawns an MCP server
 * with `roots: false` and its cwd set to the plugin folder.
 */
export function isPluginInstallPath(dirPath: string): boolean {
  if (!dirPath) return false;
  const normalized = normalizePathKey(dirPath);
  return PLUGIN_INSTALL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function redactSensitiveCommandLineFlags(commandLine: string): string {
  return commandLine.replace(/(--csrf[_-]token[=\s]+)\S+/gi, "$1[REDACTED]");
}

/**
 * Tokenize a Windows or POSIX command line into argv tokens while preserving Windows
 * path backslashes (only `\"` escapes a quote; `c:\Users\...` stays verbatim).
 */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (quote) {
      if (ch === "\\" && commandLine[i + 1] === quote) {
        current += quote;
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      inToken = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

const WORKSPACE_VALUE_FLAGS = ["--add-dir", "--project", "--folder-uri"] as const;

function normalizeExtractedWorkspaceValue(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  const candidate = trimmed.startsWith("file://") ? fileUriToFsPath(trimmed) : trimmed;
  if (!candidate || isPluginInstallPath(candidate)) return undefined;
  return candidate;
}

/**
 * Extract a workspace directory from process argv/command-line flags such as
 * `--add-dir=<path>`, `--project=<path>`, or `--folder-uri=file://...`.
 */
export function extractWorkspacePathFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    for (const flag of WORKSPACE_VALUE_FLAGS) {
      const prefix = `${flag}=`;
      if (token.startsWith(prefix)) {
        const extracted = normalizeExtractedWorkspaceValue(token.slice(prefix.length));
        if (extracted) return extracted;
      } else if (token === flag && i + 1 < args.length) {
        const extracted = normalizeExtractedWorkspaceValue(args[i + 1]);
        if (extracted) return extracted;
      }
    }
  }
  return undefined;
}

export function extractWorkspacePathFromCommandLine(commandLine: string): string | undefined {
  if (!commandLine) return undefined;
  return extractWorkspacePathFromArgs(tokenizeCommandLine(commandLine));
}

function parseLinuxStatLine(stat: string): { name: string; ppid: number } | undefined {
  const openParen = stat.indexOf("(");
  const closeParen = stat.lastIndexOf(")");
  if (openParen < 0 || closeParen <= openParen) return undefined;
  const name = stat.slice(openParen + 1, closeParen);
  const fields = stat.slice(closeParen + 2).split(" ");
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return undefined;
  return { name, ppid };
}

async function getWindowsAncestors(startPid: number, maxDepth: number): Promise<AncestorProcessCommandEntry[]> {
  if (!Number.isInteger(startPid) || startPid <= 0) return [];
  const psScript = [
    "$p = @{};",
    "Get-CimInstance Win32_Process | ForEach-Object { $p[[int]$_.ProcessId] = $_ };",
    `$cur = ${startPid};`,
    "$out = @();",
    `for ($i = 0; $i -lt ${maxDepth} -and $cur -gt 0 -and $p.ContainsKey($cur); $i++) {`,
    "  $e = $p[$cur];",
    "  $cmd = [string]$e.CommandLine -replace '(--csrf[_-]token[=\\s]+)\\S+', '$1[REDACTED]';",
    "  $out += [pscustomobject]@{ pid = [int]$e.ProcessId; ppid = [int]$e.ParentProcessId; name = [string]$e.Name; commandLine = $cmd };",
    "  if ([int]$e.ParentProcessId -eq $cur) { break };",
    "  $cur = [int]$e.ParentProcessId",
    "};",
    "if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress }",
  ].join(" ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { encoding: "utf8", windowsHide: true, timeout: 4_000 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as AncestorProcessCommandEntry | AncestorProcessCommandEntry[];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(
    (item) => typeof item?.pid === "number" && Number.isInteger(item.pid) && item.pid > 0,
  );
}

function getLinuxAncestors(startPid: number, maxDepth: number): AncestorProcessCommandEntry[] {
  const chain: AncestorProcessCommandEntry[] = [];
  let cur = startPid;
  for (let i = 0; i < maxDepth && Number.isInteger(cur) && cur > 0; i++) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${cur}/stat`, "utf8");
    } catch {
      break;
    }
    const parsedStat = parseLinuxStatLine(stat);
    if (!parsedStat) break;

    let args: string[] | undefined;
    let commandLine: string | undefined;
    try {
      const raw = readFileSync(`/proc/${cur}/cmdline`, "utf8");
      const rawArgs = raw.split("\0").filter((part) => part.length > 0);
      if (rawArgs.length > 0) {
        args = rawArgs.map((arg) => redactSensitiveCommandLineFlags(arg));
        commandLine = args.join(" ");
      }
    } catch {
      // Ignore unreadable cmdline
    }

    chain.push({
      pid: cur,
      ppid: parsedStat.ppid,
      name: parsedStat.name,
      commandLine,
      args,
    });
    if (parsedStat.ppid === cur || parsedStat.ppid <= 0) break;
    cur = parsedStat.ppid;
  }
  return chain;
}

async function getMacOsAncestors(startPid: number, maxDepth: number): Promise<AncestorProcessCommandEntry[]> {
  const chain: AncestorProcessCommandEntry[] = [];
  let cur = startPid;
  for (let i = 0; i < maxDepth && Number.isInteger(cur) && cur > 0; i++) {
    let stdout = "";
    try {
      const res = await execFileAsync(
        "ps",
        ["-ww", "-p", String(cur), "-o", "ppid=,comm="],
        { encoding: "utf8", timeout: 1_500 },
      );
      stdout = res.stdout.trim();
    } catch {
      break;
    }
    if (!stdout) break;
    const match = /^\s*(\d+)\s+(.+)$/.exec(stdout);
    if (!match) break;
    const ppid = Number(match[1]);
    const name = match[2].trim();

    let commandLine: string | undefined;
    try {
      const cmdRes = await execFileAsync(
        "ps",
        ["-ww", "-p", String(cur), "-o", "command="],
        { encoding: "utf8", timeout: 1_500 },
      );
      const rawCmd = cmdRes.stdout.trim();
      if (rawCmd) commandLine = redactSensitiveCommandLineFlags(rawCmd);
    } catch {
      // Ignore unreadable command
    }

    chain.push({ pid: cur, ppid, name, commandLine });
    if (ppid === cur || ppid <= 0) break;
    cur = ppid;
  }
  return chain;
}

/**
 * Return the current process's ancestor entries (nearest parent first) with OS command
 * line metadata, redacting sensitive flags such as `--csrf_token`. Safe on all platforms.
 */
export async function getAncestorCommandEntries(
  startPid: number = process.ppid,
  maxDepth = 12,
): Promise<AncestorProcessCommandEntry[]> {
  if (!Number.isInteger(startPid) || startPid <= 0) return [];
  try {
    if (process.platform === "win32") {
      return await getWindowsAncestors(startPid, maxDepth);
    }
    if (process.platform === "linux") {
      return getLinuxAncestors(startPid, maxDepth);
    }
    return await getMacOsAncestors(startPid, maxDepth);
  } catch {
    return [];
  }
}

export interface ResolveWorkspaceFromAncestorsOptions {
  startPid?: number;
  ancestors?: readonly AncestorProcessCommandEntry[];
  readAgyProject?: (pid: number) => string | undefined;
  checkExists?: boolean;
}

/**
 * Walk ancestor processes (nearest-first) to recover the real workspace path when
 * an IDE/CLI plugin spawns the MCP server from a global plugin directory and sets
 * `roots: false`. Checks explicit workspace flags (`--add-dir`, `--project`, `--folder-uri`)
 * and `agy-<pid>.json` conversation records if provided.
 */
export async function resolveWorkspaceFromAncestors(
  options: ResolveWorkspaceFromAncestorsOptions = {},
): Promise<string | undefined> {
  const ancestors = options.ancestors ?? (await getAncestorCommandEntries(options.startPid));
  const checkExists = options.checkExists ?? true;

  const isAcceptable = (candidate: string | undefined): candidate is string => {
    if (!candidate || isPluginInstallPath(candidate)) return false;
    return !checkExists || existsSync(candidate);
  };

  for (const entry of ancestors) {
    const fromCmd = entry.args
      ? extractWorkspacePathFromArgs(entry.args)
      : entry.commandLine
        ? extractWorkspacePathFromCommandLine(entry.commandLine)
        : undefined;
    if (isAcceptable(fromCmd)) return fromCmd;

    const fromAgy = options.readAgyProject?.(entry.pid);
    if (isAcceptable(fromAgy)) return fromAgy;
  }

  return undefined;
}

