/**
 * agent-communication-bridge plugin for OpenCode (2.x, and 1.x from 1.18.29).
 *
 * Auto-loaded from .opencode/plugins/ or ~/.config/opencode/plugins/ — no
 * entry needed in opencode.json(c). Node / Bun built-ins only, no npm install.
 *
 * 1. Registers the agent-communication-bridge MCP server (an existing entry wins), so the
 *    model gets list_agents / message_client_session / channel_inbox / reply.
 * 2. Opens a host inbox socket for this OpenCode server process and project.
 *    The MCP adapter is the server's child: it writes each incoming channel
 *    message there, already wrapped with the reply template, and the plugin
 *    queues it as a prompt in the active session. Routing, the identity wall
 *    and acks stay in the adapter, so the plugin registers nothing itself.
 *
 * One default export serves both plugin APIs: OpenCode 2 reads `id` + `setup`,
 * OpenCode 1 (≥ 1.18.29) calls `server()`.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MCP_ENTRY = {
  type: "local",
  command: ["agent-communication-bridge", "mcp", "start"],
  ...(process.env.AGENT_BRIDGE_IDENTITY ? { environment: { AGENT_BRIDGE_IDENTITY: process.env.AGENT_BRIDGE_IDENTITY } } : {}),
};

interface InboxMeta {
  model?: string;
  reasoning?: string;
}

function normalizeDirKey(dir: string): string {
  let p = dir.trim().replace(/\\/g, "/");
  p = p.startsWith("//") ? `//${p.slice(2).replace(/\/+/g, "/")}` : p.replace(/\/+/g, "/");
  if (p.length > 1 && !/^[a-zA-Z]:\/$/.test(p)) p = p.replace(/\/+$/, "");
  if (process.platform === "win32" || /^[a-zA-Z]:\//.test(p)) p = p.toLowerCase();
  return p;
}

function parseModelOverride(rawModel?: string, rawReasoning?: string): {
  model?: { providerID: string; modelID: string };
  variant?: string;
} {
  let variant = rawReasoning?.trim() || undefined;
  let modelStr = rawModel?.trim();
  if (modelStr && modelStr.includes("#")) {
    const [base, hashVariant] = modelStr.split("#", 2);
    modelStr = base?.trim();
    if (!variant && hashVariant?.trim()) variant = hashVariant.trim();
  }
  if (!modelStr) {
    return { ...(variant ? { variant } : {}) };
  }
  const sepIdx = modelStr.includes("/") ? modelStr.indexOf("/") : modelStr.indexOf(":");
  if (sepIdx <= 0 || sepIdx === modelStr.length - 1) {
    console.error(
      `[agent-communication-bridge] Ignoring model override "${modelStr}" without provider prefix (expected "provider/model", e.g. "anthropic/claude-sonnet-4-6")`,
    );
    return { ...(variant ? { variant } : {}) };
  }
  const providerID = modelStr.slice(0, sepIdx).trim();
  const modelID = modelStr.slice(sepIdx + 1).trim();
  if (!providerID || !modelID) {
    return { ...(variant ? { variant } : {}) };
  }
  return {
    model: { providerID, modelID },
    ...(variant ? { variant } : {}),
  };
}

// Keep in sync with src/client/host-inbox-socket.ts (this file is installed standalone).
// One OpenCode server can host several projects, so the socket is scoped by directory.
function listenHostInbox(directory: string, onMessage: (content: string, meta?: InboxMeta) => void): Promise<() => void> {
  const scope = createHash("sha256").update(normalizeDirKey(directory)).digest("hex").slice(0, 12);
  const path = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "agent-communication-bridge", `inbox-${process.pid}-${scope}.sock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const useTcp = process.platform === "win32";
  const expectedToken = useTcp ? randomBytes(16).toString("hex") : undefined;
  const seen = new Set<string>();
  const server = createServer((conn) => {
    let buf = "";
    let authed = !expectedToken;
    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const frame = JSON.parse(line) as { type?: string; token?: string; id?: string; message?: { content?: unknown }; meta?: InboxMeta };
        if (frame.type === "auth" && expectedToken) {
          authed = frame.token === expectedToken;
          return;
        }
        if (!authed) return;
        if (frame.type !== "user" || typeof frame.message?.content !== "string") return;
        // Two adapters in one agent (an old MCP entry next to the plugin's) or a
        // registry replay write the same message twice; start its turn once.
        if (frame.id) {
          if (seen.has(frame.id)) return;
          seen.add(frame.id);
          if (seen.size > 500) seen.delete(seen.values().next().value as string);
        }
        onMessage(frame.message.content, frame.meta);
      } catch {
        // not a frame — ignore
      }
    };
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 2 * 1024 * 1024) {
        conn.destroy();
        return;
      }
      let nlIdx = buf.indexOf("\n");
      while (nlIdx !== -1) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        processLine(line);
        nlIdx = buf.indexOf("\n");
      }
    });
    conn.on("end", () => {
      if (buf.trim()) {
        processLine(buf);
        buf = "";
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      process.off("exit", close);
      server.close();
      rmSync(path, { force: true });
    };
    if (useTcp) {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr) {
          close();
          reject(new Error("Failed to bind host inbox loopback TCP port"));
          return;
        }
        writeFileSync(
          path,
          JSON.stringify({ transport: "tcp", host: "127.0.0.1", port: addr.port, token: expectedToken }),
          { mode: 0o600 },
        );
        process.once("exit", close);
        resolve(close);
      });
    } else {
      server.listen(path, () => {
        chmodSync(path, 0o600);
        process.once("exit", close);
        resolve(close);
      });
    }
  });
}

/** The session id an event refers to, whatever its envelope looks like. */
// biome-ignore lint/suspicious/noExplicitAny: event shapes differ between OpenCode versions
function sessionOf(event: any): string | undefined {
  const p = event?.properties ?? event?.data ?? event;
  return p?.sessionID ?? (String(event?.type ?? "").startsWith("session.") ? p?.info?.id ?? p?.id : undefined);
}

// ── OpenCode 2 ────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: OpenCode's plugin context is not a dependency here
async function setup(ctx: any): Promise<() => void> {
  await ctx.mcp.transform((editor: { get(n: string): unknown; set(n: string, c: unknown): void }) => {
    if (!editor.get("agent-communication-bridge")) editor.set("agent-communication-bridge", MCP_ENTRY);
  });

  let active: string | undefined;
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) active = sessionOf(event) ?? active;
    } catch {
      // stream closed on unload
    }
  })();

  const directory: string = ctx.location.directory;
  let bridgeSession: string | undefined;

  /** The session the user is working in, if it belongs to this project. The
   *  event stream is server-wide, so a session id alone is not enough. */
  async function activeHere(): Promise<string | undefined> {
    if (!active) return undefined;
    try {
      const info = await ctx.session.get({ sessionID: active });
      const where = info?.directory ?? info?.location?.directory;
      return where === undefined || normalizeDirKey(where) === normalizeDirKey(directory) ? active : undefined;
    } catch {
      return undefined;
    }
  }

  const closeInbox = await listenHostInbox(directory, async (text, meta) => {
    try {
      // With no session open (TUI on its home screen) the adapter has already
      // acked the message, so it must not be dropped: run it in a session of
      // its own, like the Codex bridge's thread, and reuse that one afterwards.
      let sessionID = await activeHere();
      if (!sessionID) {
        bridgeSession ??= (await ctx.session.create({ title: "agent-communication-bridge" }))?.id;
        sessionID = bridgeSession;
      }
      const override = parseModelOverride(meta?.model, meta?.reasoning);
      // "queue", not the default "steer": never mix a peer's message into the user's running turn.
      if (sessionID) {
        await ctx.session.prompt({
          sessionID,
          text,
          delivery: "queue",
          ...(override.model ? { model: override.model } : {}),
          ...(override.variant ? { variant: override.variant } : {}),
        });
      }
    } catch (err) {
      console.error(`[agent-communication-bridge] could not deliver a channel message: ${err}`);
    }
  });

  return () => {
    controller.abort();
    closeInbox();
  };
}

// ── OpenCode 1 (≥ 1.18.29) ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: OpenCode's plugin input is not a dependency here
async function server(ctx: any) {
  let active: string | undefined;
  await listenHostInbox(ctx.directory ?? process.cwd(), async (text, meta) => {
    let id = active;
    if (!id) {
      const sessions = await ctx.client.session.list().catch(() => []);
      id = Array.isArray(sessions) ? sessions[sessions.length - 1]?.id : undefined;
    }
    const override = parseModelOverride(meta?.model, meta?.reasoning);
    if (id) {
      await ctx.client.session.prompt_async({
        id,
        parts: [{ type: "text", text }],
        noReply: false,
        ...(override.model ? { model: override.model } : {}),
        ...(override.variant ? { variant: override.variant } : {}),
      }).catch(() => {});
    }
  });
  return {
    // biome-ignore lint/suspicious/noExplicitAny: OpenCode's Config type is not a dependency here
    async config(cfg: any) {
      cfg.mcp ??= {};
      cfg.mcp["agent-communication-bridge"] ??= { ...MCP_ENTRY, enabled: true };
    },
    async event(input: { event: unknown }) {
      active = sessionOf(input.event) ?? active;
    },
  };
}

export default { id: "agent-communication-bridge", setup, server };
