import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessAncestorEntry {
  pid: number;
  name: string;
}

const cachedEntries = new Map<number, ProcessAncestorEntry[]>();

/**
 * Return ancestor entries `[{ pid, name }, ...]` starting at `startPid` up to
 * `maxDepth` hops. Uses a single OS query (`Get-CimInstance` on Windows or `/proc`
 * on Linux) so callers never pay per-hop shell startup overhead.
 */
export function getParentProcessEntries(startPid = process.ppid, maxDepth = 6): ProcessAncestorEntry[] {
  if (!Number.isInteger(startPid) || startPid <= 1) return [];
  const cached = cachedEntries.get(startPid);
  if (cached) return cached;

  const entries: ProcessAncestorEntry[] = [];
  let lookupSucceeded = false;

  if (process.platform === "win32") {
    try {
      const script =
        "$m=@{}; Get-CimInstance Win32_Process | ForEach-Object { $m[[int]$_.ProcessId]=@([int]$_.ParentProcessId, [string]$_.Name) }; " +
        `$p=${startPid}; for($i=0; $i -lt ${maxDepth}; $i++) { if(-not $m.ContainsKey($p)) { break }; $e=$m[$p]; "$p|$($e[1])"; $pp=$e[0]; if($pp -le 1 -or $pp -eq $p) { break }; $p=$pp }`;
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 4_000, windowsHide: true },
      );
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sepIdx = trimmed.indexOf("|");
        if (sepIdx === -1) continue;
        const pid = Number(trimmed.slice(0, sepIdx));
        const name = trimmed.slice(sepIdx + 1).trim();
        if (Number.isInteger(pid) && pid > 1 && !entries.some((e) => e.pid === pid)) {
          entries.push({ pid, name });
        }
      }
      lookupSucceeded = entries.length > 0;
    } catch {
      // Ignore WMI lookup failures (do not poison cache so future calls can retry).
    }
  } else {
    lookupSucceeded = true;
    let current = startPid;
    for (let i = 0; i < maxDepth && current > 1; i++) {
      let comm = "";
      let ppid = 0;
      try {
        const stat = readFileSync(`/proc/${current}/stat`, "utf8");
        const openParen = stat.indexOf("(");
        const closeParen = stat.lastIndexOf(")");
        if (openParen !== -1 && closeParen > openParen) {
          comm = stat.slice(openParen + 1, closeParen);
        }
        if (closeParen !== -1) {
          const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
          ppid = Number(fields[1]);
        }
      } catch {
        // Fallback to `ps` on macOS/BSD where /proc is absent
        try {
          const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(current)], { encoding: "utf8" }).trim();
          const [ppidStr, nameStr = ""] = out.split(/\s+/, 2);
          ppid = Number(ppidStr);
          comm = nameStr;
        } catch {
          break;
        }
      }
      if (!entries.some((e) => e.pid === current)) {
        entries.push({ pid: current, name: comm });
      }
      if (!Number.isInteger(ppid) || ppid <= 1 || entries.some((e) => e.pid === ppid)) break;
      current = ppid;
    }
  }

  if (entries.length === 0) {
    entries.push({ pid: startPid, name: "" });
  }
  if (lookupSucceeded) {
    cachedEntries.set(startPid, entries);
  }
  return entries;
}

/**
 * Return `[startPid, parent, grandparent, ...]` up to `maxDepth` ancestors.
 * Useful on Windows where `.cmd` shims insert `cmd.exe` between a host IDE/CLI
 * (Antigravity, OpenCode) and the spawned MCP child process.
 */
export function getParentProcessChain(startPid = process.ppid, maxDepth = 6): number[] {
  return getParentProcessEntries(startPid, maxDepth).map((e) => e.pid);
}

