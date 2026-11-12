/**
 * Host Inbox Sockets — In-process turn injection for OpenCode and Antigravity sidecars.
 *
 * Host plugins bind a local Unix domain socket / named pipe keyed by the host
 * process PID (and optional workspace directory digest). The child MCP adapter
 * discovers the parent socket via `process.ppid` and transmits newline-delimited
 * JSON frames (`{"type":"user","id":"...","message":{"role":"user","content":"..."}}`)
 * to trigger a live turn inside the host session.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizePathKey } from "../utils/path.js";
import { getParentProcessChain } from "./process-ancestors.js";

export interface HostInboxDeliveryOptions {
  socketPath: string;
  token?: string;
  timeoutMs?: number;
  id?: string;
  meta?: { model?: string; reasoning?: string };
}

function directoryScopeHash(directory?: string): string {
  if (!directory) return "";
  return `-${createHash("sha256").update(normalizePathKey(directory)).digest("hex").slice(0, 12)}`;
}

/**
 * Compute the deterministic socket path for `hostPid` and optional `directory`.
 */
export function hostInboxSocketPath(
  hostPid: number,
  env: NodeJS.ProcessEnv = process.env,
  directory?: string,
): string {
  const scope = directoryScopeHash(directory);
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "agent-communication-bridge", `inbox-${hostPid}${scope}.sock`);
}

/**
 * Locate an active host inbox socket opened by an ancestor process (usually
 * `process.ppid`, or its parent on Windows when wrapped in a `.cmd` shim).
 */
export function parentHostInboxSocket(env: NodeJS.ProcessEnv = process.env, directory?: string): string | null {
  const pids = getParentProcessChain(process.ppid);
  const baseDir = env.XDG_RUNTIME_DIR || tmpdir();
  const subdirs = ["agent-communication-bridge", "open-agent-bridge"];
  const scope = directoryScopeHash(directory);

  for (const pid of pids) {
    for (const sub of subdirs) {
      if (scope) {
        const scoped = join(baseDir, sub, `inbox-${pid}${scope}.sock`);
        if (existsSync(scoped)) return scoped;
      }
      const plain = join(baseDir, sub, `inbox-${pid}.sock`);
      if (existsSync(plain)) return plain;
    }
  }
  return null;
}

interface TcpEndpointDescriptor {
  transport: "tcp";
  host: string;
  port: number;
  token?: string;
}

function readTcpDescriptor(socketPath: string): TcpEndpointDescriptor | null {
  try {
    const raw = readFileSync(socketPath, "utf8").trim();
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as Partial<TcpEndpointDescriptor>;
    if (parsed.transport === "tcp" && typeof parsed.host === "string" && typeof parsed.port === "number") {
      return parsed as TcpEndpointDescriptor;
    }
  } catch {
    // Unix socket files cannot be read as regular files; treat as Unix path.
  }
  return null;
}

/**
 * Write a user turn frame to a host inbox socket. Resolves `true` on clean flush,
 * or `false` on connection error or timeout. Never throws.
 */
export function deliverViaHostInboxSocket(
  content: string,
  options: HostInboxDeliveryOptions,
): Promise<boolean> {
  const { socketPath, token, timeoutMs = 3_000, id, meta } = options;
  if (!socketPath) return Promise.resolve(false);

  const tcp = readTcpDescriptor(socketPath);
  const effectiveToken = tcp?.token ?? token;

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    const timer = setTimeout(() => finalize(false), timeoutMs);
    const onConnect = () => {
      const authLine = effectiveToken ? `${JSON.stringify({ type: "auth", token: effectiveToken })}\n` : "";
      const hasMeta = Boolean(meta?.model || meta?.reasoning);
      const userLine = `${JSON.stringify({
        type: "user",
        ...(id ? { id } : {}),
        message: { role: "user", content },
        ...(hasMeta ? { meta } : {}),
      })}\n`;
      socket.end(authLine + userLine, () => finalize(true));
    };
    const socket = tcp
      ? createConnection({ host: tcp.host, port: tcp.port }, onConnect)
      : createConnection(socketPath, onConnect);
    socket.on("error", () => finalize(false));
  });
}

/**
 * Bind and listen on the host inbox socket for `hostPid`, invoking `onMessage`
 * for each unique inbound `user` frame. Returns a cleanup callback.
 */
export function listenHostInbox(
  hostPid: number,
  onMessage: (content: string, meta?: { model?: string; reasoning?: string }) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => void> {
  const path = hostInboxSocketPath(hostPid, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });

  const useTcp = process.platform === "win32";
  const expectedToken = useTcp ? randomBytes(16).toString("hex") : undefined;

  const dedupWindow = new Set<string>();
  const server: Server = createServer((conn) => {
    let buffer = "";
    let authed = !expectedToken;
    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      try {
        const frame = JSON.parse(line) as {
          type?: string;
          token?: string;
          id?: string;
          message?: { content?: unknown };
          meta?: { model?: string; reasoning?: string };
        };
        if (frame.type === "auth" && expectedToken) {
          authed = frame.token === expectedToken;
          return;
        }
        if (!authed) return;
        if (frame.type !== "user" || typeof frame.message?.content !== "string") return;
        if (frame.id) {
          if (dedupWindow.has(frame.id)) return;
          dedupWindow.add(frame.id);
          if (dedupWindow.size > 500) {
            const oldest = dedupWindow.values().next().value;
            if (oldest !== undefined) dedupWindow.delete(oldest);
          }
        }
        onMessage(frame.message.content, frame.meta);
      } catch {
        // Ignore malformed JSON frames
      }
    };

    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) {
        conn.destroy();
        return;
      }
      let nlIdx = buffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        processLine(line);
        nlIdx = buffer.indexOf("\n");
      }
    });
    conn.on("end", () => {
      if (buffer.trim()) {
        processLine(buffer);
        buffer = "";
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      process.off("exit", cleanup);
      server.close();
      rmSync(path, { force: true });
    };
    if (useTcp) {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr) {
          cleanup();
          reject(new Error("Failed to bind host inbox loopback TCP port"));
          return;
        }
        writeFileSync(
          path,
          JSON.stringify({ transport: "tcp", host: "127.0.0.1", port: addr.port, token: expectedToken }),
          { mode: 0o600 },
        );
        process.once("exit", cleanup);
        resolve(cleanup);
      });
    } else {
      server.listen(path, () => {
        chmodSync(path, 0o600);
        process.once("exit", cleanup);
        resolve(cleanup);
      });
    }
  });
}
