/**
 * Codex native delivery through the app-server daemon (codex-cli ≥ 0.162).
 *
 * The interactive `codex` TUI no longer runs its own engine: it attaches to a
 * shared app-server daemon listening on a Unix socket (WebSocket over UDS) at
 * `$CODEX_HOME/app-server-control/app-server-control.sock`. The MCP adapter is
 * one of that daemon's MCP servers (one per thread), so it can open the same
 * socket, find its own thread and start a turn there. The message shows up
 * in the user's live TUI as a new turn and Codex answers it in place, calling
 * the `reply` tool like any other MCP tool — the Codex counterpart of the
 * host inbox socket (verified against codex-cli 0.162.1).
 *
 * A busy thread is not interrupted: we wait for its `thread/status/changed`
 * to `idle` and take the next turn, matching host inbox queueing.
 */

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { WebSocket, type ClientOptions } from "ws";
import { pathsEqual } from "../utils/path.js";
import { killProcessTree, spawnBinary } from "../utils/process.js";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

interface ThreadSummary {
  id: string;
  cwd?: string;
  status?: { type?: string };
}

export interface CodexDaemonOptions {
  /** Project directory; the target is a loaded thread whose cwd matches it. */
  cwd: string;
  socketPath?: string | null;
  /** How long to wait for a busy thread to go idle before giving up. */
  idleWaitMs?: number;
  /** How long connecting + finding the thread may take. Default 10 s. */
  discoveryTimeoutMs?: number;
  /** When this adapter process started (ms epoch). Default: from process.uptime(). */
  startedAt?: number;
  /** Optional per-turn model override. */
  model?: string;
  /** Optional per-turn reasoning effort override. */
  effort?: string;
}

/** Thread ids are UUIDv7: the first 48 bits are the creation time in ms. */
function uuidV7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/**
 * True when `codex --version` output names a release whose TUI runs on the
 * shared app-server daemon (≥ 0.162), i.e. one this module can deliver into.
 */
export function codexSupportsDaemon(versionOutput: string | null | undefined): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput ?? "");
  // ponytail: unknown version → assume modern; `acb codex start` covers older ones.
  if (!m) return true;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major * 1e6 + minor * 1e3 + patch >= 162_000;
}

/** The daemon's control socket, or null when no Codex daemon is running. */
export function codexDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = join(home, "app-server-control", "app-server-control.sock");
  return existsSync(path) ? path : null;
}

/**
 * Start a turn with `content` on the live Codex thread for `cwd`. Resolves
 * `true` once the daemon accepted the turn; `false` when there is no daemon,
 * no loaded thread for the project, a newer session owns the project, the
 * thread stayed busy past `idleWaitMs`, or anything failed — so the caller can
 * leave the message pending and retry later. Never throws.
 */
export function deliverViaCodexDaemon(content: string, options: CodexDaemonOptions): Promise<boolean> {
  const socketPath = options.socketPath === undefined ? codexDaemonSocketPath() : options.socketPath;
  if (!socketPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    let proxyChild: ChildProcess | undefined;
    const wsOptions: ClientOptions = {};
    const isWsUrl = socketPath.startsWith("ws://") || socketPath.startsWith("wss://");
    const isWinPipe = socketPath.startsWith("\\\\.\\pipe\\");
    if (isWinPipe) {
      (wsOptions as Record<string, unknown>).createConnection = () => connect(socketPath);
    } else if (!isWsUrl && process.platform === "win32") {
      proxyChild = spawnBinary("codex", ["app-server", "proxy"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const duplex = Duplex.from({
        writable: proxyChild.stdin!,
        readable: proxyChild.stdout!,
      });
      (wsOptions as Record<string, unknown>).createConnection = () => duplex;
    }

    const wsUrl = isWsUrl
      ? socketPath
      : isWinPipe || process.platform === "win32"
        ? "ws://localhost/"
        : `ws+unix://${socketPath}:/`;
    const ws = new WebSocket(wsUrl, wsOptions);
    const pending = new Map<number, (msg: RpcMessage) => void>();
    /** Latest status per thread, including changes that land mid-discovery. */
    const statusOf = new Map<string, string>();
    let nextId = 0;
    let threadId: string | null = null;
    let started = false;
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(discoveryTimer);
      try {
        ws.close();
      } catch {}
      if (proxyChild) {
        killProcessTree(proxyChild);
      }
      resolve(ok);
    };
    // ponytail: one flat budget covers connect + waiting for idle; a thread busy
    // longer than this stays pending for the next registry sync instead of
    // holding a socket open.
    const timer = setTimeout(() => done(false), options.idleWaitMs ?? 5 * 60_000);
    // A daemon that accepts the connection but never answers must not hold the
    // message for the whole idle budget.
    const discoveryTimer = setTimeout(() => threadId || done(false), options.discoveryTimeoutMs ?? 10_000);

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<RpcMessage>((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });

    const startTurn = async () => {
      if (started || !threadId) return;
      started = true;
      const res = await call("turn/start", {
        threadId,
        input: [{ type: "text", text: content }],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      });
      done(!res.error);
    };

    ws.on("message", (raw) => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(String(raw)) as RpcMessage;
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      const status = msg.params?.status as { type?: string } | undefined;
      const changed = msg.params?.threadId;
      if (msg.method === "thread/status/changed" && typeof changed === "string" && status?.type) {
        statusOf.set(changed, status.type);
        if (changed === threadId && status.type === "idle") void startTurn();
      }
    });
    ws.on("error", () => done(false));
    ws.on("close", () => done(false));
    ws.on("open", async () => {
      try {
        await call("initialize", { clientInfo: { name: "agent-communication-bridge", version: "0.1.0" } });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        // thread/read, not thread/list: a thread with no turns yet is not listed.
        const loaded = ((await call("thread/loaded/list", {})).result?.data as string[]) ?? [];
        const reads = await Promise.all(
          loaded.map(async (id) => ({ id, read: (await call("thread/read", { threadId: id })).result })),
        );
        const candidates: ThreadSummary[] = [];
        for (const { id, read } of reads) {
          const thread = (read?.thread ?? read) as Record<string, unknown> | undefined;
          const cwd =
            (thread?.cwd as string | undefined) ??
            ((thread?.environments as Array<{ cwd?: string }> | undefined)?.[0]?.cwd);
          if (pathsEqual(cwd, options.cwd)) {
            candidates.push({ ...(thread as object), id, cwd } as ThreadSummary);
          }
        }
        // The daemon keeps threads loaded after their TUI closes, so the cwd alone
        // is ambiguous. It starts one MCP adapter per thread right as the thread is
        // created, so ours is the one born closest to this process.
        // ponytail: a resumed old thread spawns a fresh adapter but keeps its old
        // id; that only misroutes when another thread is live in the same project.
        const startedAt = options.startedAt ?? Date.now() - process.uptime() * 1000;
        const thread = candidates.sort(
          (a, b) => Math.abs(uuidV7Time(a.id) - startedAt) - Math.abs(uuidV7Time(b.id) - startedAt),
        )[0];
        if (!thread) return done(false);
        // Adapters of closed TUIs stay alive with the same agentId and would each
        // answer from their dead thread. Only the newest session delivers.
        if (candidates.some((c) => uuidV7Time(c.id) > uuidV7Time(thread.id))) return done(false);
        threadId = thread.id;
        if ((statusOf.get(thread.id) ?? thread.status?.type) === "idle") await startTurn();
      } catch {
        done(false);
      }
    });
  });
}
