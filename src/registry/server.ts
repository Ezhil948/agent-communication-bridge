// Registry HTTP server — central discovery service on :4999
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AgentStore, shouldReplaceRegistryEntry } from "./store.js";
import { RegistryEventBus } from "./events.js";
import { ChannelStore } from "./channel-store.js";
import { localCorsMiddleware } from "../utils/http.js";
import { pathsEqual } from "../utils/path.js";
import type { RegistryEvent } from "./events.js";
import type {
  AgentRegistration,
  AgentListFilter,
  AgentMessage,
  ChannelAck,
  ChannelMessage,
} from "../types/messages.js";

const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const ACK_SWEEP_INTERVAL_MS = 60_000;
const CONVERSATION_CLEANUP_INTERVAL_MS = 60 * 60_000; // hourly
const CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60_000; // 30 days
// Resolved (answered/failed) threads are pruned aggressively so a burst of
// handled traffic never buries or stalls fresh messages in any inbox.
const TERMINAL_SWEEP_INTERVAL_MS = 5 * 60_000; // every 5 min
const TERMINAL_RETENTION_MS = 60 * 60_000; // keep resolved threads 60 min

export class RegistryServer {
  private eventBus = new RegistryEventBus();
  private store = new AgentStore(this.eventBus);
  private channelStore: ChannelStore;
  private app = express();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private ackSweepTimer: NodeJS.Timeout | null = null;
  private conversationCleanupTimer: NodeJS.Timeout | null = null;
  private terminalSweepTimer: NodeJS.Timeout | null = null;
  private wsClients = new Set<WebSocket>();
  private agentWsMap = new Map<string, WebSocket>();

  constructor(private readonly port = REGISTRY_PORT, dbPath?: string) {
    this.channelStore = new ChannelStore(dbPath);
    this.setupRoutes();
  }

  /** Actual listening TCP port (useful when started on ephemeral port `0`). */
  getPort(): number {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.port;
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // Loopback-only CORS headers so external web origins cannot call local endpoints
    this.app.use(localCorsMiddleware("GET, POST, DELETE, OPTIONS"));

    // Handle preflight (Express 5 requires named wildcard)
    this.app.options("/{*path}", (_req, res) => {
      res.sendStatus(204);
    });

    // Register an agent
    this.app.post("/agents", (req, res) => {
      const registration = req.body as AgentRegistration;
      const entry = this.store.register(registration);
      res.status(201).json(entry);
    });

    // Deregister an agent
    this.app.delete("/agents/:id", (req, res) => {
      const removed = this.store.deregister(req.params.id);
      res.json({ removed });
    });

    // Heartbeat
    this.app.post("/agents/:id/heartbeat", (req, res) => {
      const updated = this.store.heartbeat(req.params.id);
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ ok: true, timestamp: Date.now() });
    });

    // List agents (with optional filters)
    this.app.get("/agents", (req, res) => {
      const filter: AgentListFilter = {
        skill: req.query.skill as string | undefined,
        project: req.query.project as string | undefined,
        healthy: req.query.healthy === "true" ? true : req.query.healthy === "false" ? false : undefined,
        entryType: req.query.entryType as "agent" | "client" | undefined,
      };
      res.json(this.store.list(filter));
    });

    // Get specific agent
    this.app.get("/agents/:id", (req, res) => {
      const entry = this.store.get(req.params.id);
      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(entry);
    });

    // Registry health
    this.app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        agents: this.store.count(),
        wsConnections: this.agentWsMap.size,
        timestamp: new Date().toISOString(),
      });
    });

    // Task lifecycle events from agents
    this.app.post("/events", (req, res) => {
      const { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName } = req.body as {
        agentId: string;
        agentName: string;
        taskId: string;
        state: string;
        skillId?: string;
        timestamp: string;
        payload?: unknown;
        clientId?: string;
        clientName?: string;
      };

      const event: RegistryEvent = {
        type: "task.update",
        timestamp: timestamp ?? new Date().toISOString(),
        data: { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName },
      };

      this.eventBus.broadcast(event);
      res.json({ ok: true });
    });

    this.app.post("/channel/messages", (req, res) => {
      const body = req.body as Partial<ChannelMessage>;

      if (!body.content || !body.fromAgentId || !body.kind) {
        res.status(400).json({ error: "fromAgentId, kind and content are required" });
        return;
      }

      const revived = body.conversationId
        ? this.channelStore.reviveConversation(body.conversationId)
        : false;
      const { message, created } = this.channelStore.createMessage({
        conversationId: body.conversationId,
        messageId: body.messageId,
        replyTo: body.replyTo,
        fromAgentId: body.fromAgentId,
        fromAgentName: body.fromAgentName,
        toAgentId: body.toAgentId,
        taskId: body.taskId,
        kind: body.kind,
        content: body.content,
        meta: body.meta,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
        attemptCount: body.attemptCount,
        requiresAck: body.requiresAck,
        expectsResponse: body.expectsResponse,
        identity: body.identity,
      });

      // Idempotency: if a duplicate `messageId` was posted, suppress all broadcasts.
      // The 200 response below still echoes the canonical persisted message so the
      // caller can treat the retry as success.
      if (created) {
        // Send revive BEFORE the message so receiving clients clear deletedConversationIds
        // before trackMessage() runs — otherwise the message would be silently dropped.
        if (revived) {
          this.eventBus.broadcast({
            type: "channel.conversation.revived",
            timestamp: new Date().toISOString(),
            data: { conversationId: message.conversationId },
          });
        }

        this.eventBus.broadcast({
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: message,
        });

        // Targeted delivery via sendToAgent (auto-evicts dead WS).
        if (message.toAgentId) {
          this.sendToAgent(message.toAgentId, {
            type: "channel.message",
            timestamp: new Date().toISOString(),
            data: message,
          });
        }
      }

      res.status(created ? 201 : 200).json({ ...message, deduplicated: !created });
    });

    this.app.post("/channel/acks", (req, res) => {
      const body = req.body as ChannelAck;
      if (!body.conversationId || !body.messageId || !body.state || !body.actorId || !body.actorType) {
        res.status(400).json({ error: "conversationId, messageId, state, actorId and actorType are required" });
        return;
      }

      const ack = this.channelStore.addAck({
        ...body,
        timestamp: body.timestamp ?? Date.now(),
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: ack,
      });

      res.status(201).json(ack);
    });

    this.app.get("/channel/snapshots", (req, res) => {
      const pendingOnly = req.query.pending === "true";
      res.json(this.channelStore.listConversationSnapshots({ pendingOnly }));
    });

    this.app.get("/channel/conversations/:id", (req, res) => {
      const snapshot = this.channelStore.getConversation(req.params.id);
      if (!snapshot) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(snapshot);
    });

    this.app.get("/channel/conversations", (req, res) => {
      const pendingOnly = req.query.pending === "true";
      res.json(this.channelStore.listConversations({ pendingOnly }));
    });

    this.app.post("/channel/conversations/:id/suppress", (req, res) => {
      const suppressed = this.channelStore.suppressConversation(req.params.id);
      if (!suppressed) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.conversation.suppressed",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });

      res.json({ suppressed: true });
    });

    this.app.delete("/channel/conversations/:id/suppress", (req, res) => {
      const revived = this.channelStore.reviveConversation(req.params.id);
      this.eventBus.broadcast({
        type: "channel.conversation.revived",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });
      res.json({ revived });
    });

    this.app.post("/channel/messages/:conversationId/:messageId/retry", (req, res) => {
      const retried = this.channelStore.retryMessage(req.params.conversationId, req.params.messageId);
      if (!retried) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.message",
        timestamp: new Date().toISOString(),
        data: retried,
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: this.channelStore.addAck({
          conversationId: retried.conversationId,
          messageId: retried.messageId,
          state: "queued",
          actorId: "registry",
          actorType: "registry",
          timestamp: Date.now(),
          detail: `Retry attempt ${retried.attemptCount ?? 1}`,
        }),
      });

      // Targeted delivery: if message has a specific recipient, send directly to their WS
      if (retried.toAgentId) {
        this.sendToAgent(retried.toAgentId, {
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: retried,
        });
      }

      res.json(retried);
    });

    // Send message to a specific agent via registry relay
    this.app.post("/agents/:id/message", (req, res) => {
      const targetId = req.params.id;
      const message = req.body as AgentMessage;

      // Try to find agent by ID or name
      const entry = this.store.get(targetId) ??
        this.store.list().find((a) => a.name.toLowerCase() === targetId.toLowerCase());

      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const resolvedId = entry.agentId;
      const sent = this.sendToAgent(resolvedId, {
        type: "agent.message",
        timestamp: new Date().toISOString(),
        data: message,
      });

      if (sent) {
        // Broadcast to observer WS subscribers too
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: true, via: "websocket" });
      } else {
        // No WS — broadcast event, caller should fallback to HTTP direct
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: false, via: "event-only" });
      }
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer(this.app);

    // WebSocket server on /ws path
    const wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wss = wss;

    // WebSocket keepalive: ping every 15s, terminate if no pong within 15s.
    // Worst-case zombie window is ~30s (one missed cycle + the next), versus
    // ~50s with the previous 25s interval.
    //
    // When we terminate a zombie, we also evict its entry from agentWsMap so
    // targeted delivery doesn't silently write into a dead socket while waiting
    // for the natural `close` event to fire. Without this, every agentWsMap
    // lookup between terminate() and the close handler would race with a
    // half-open socket whose readyState may still report OPEN.
    const wsPingInterval = setInterval(() => {
      for (const client of wss.clients) {
        if ((client as any)._isAlive === false) {
          const agentId = (client as any)._identifiedAgentId as string | undefined;
          if (agentId && this.agentWsMap.get(agentId) === client) {
            this.agentWsMap.delete(agentId);
            console.error(`[Registry] WS keepalive: evicted ${agentId} from routing map (no pong)`);
          }
          client.terminate();
          continue;
        }
        (client as any)._isAlive = false;
        client.ping();
      }
    }, 15_000);

    wss.on("close", () => clearInterval(wsPingInterval));

    wss.on("connection", (ws) => {
      (ws as any)._isAlive = true;
      ws.on("pong", () => { (ws as any)._isAlive = true; });
      this.wsClients.add(ws);
      let identifiedAgentId: string | null = null;

      // Send snapshot of current agents
      ws.send(
        JSON.stringify({ type: "snapshot", agents: this.store.list() })
      );

      // Subscribe to EventBus and forward events
      const onEvent = (event: RegistryEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Targeted channel messages are delivered directly via sendToAgent(toAgentId).
        // Avoid duplicating them to the target or leaking them across identified peers;
        // unidentified listeners (e.g. observer WS clients) still observe all events.
        if (event.type === "channel.message" && identifiedAgentId) {
          const msgData = event.data as ChannelMessage | undefined;
          if (msgData?.toAgentId) return;
        }
        ws.send(JSON.stringify(event));
      };
      this.eventBus.on("event", onEvent);

      // Handle incoming messages from agents
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Agent identification — agent sends { type: "identify", agentId: "..." }
          if (msg.type === "identify" && msg.agentId) {
            // Same agent re-identifying on the same socket — just ack, no re-mapping
            if (identifiedAgentId === msg.agentId && this.agentWsMap.get(msg.agentId) === ws) {
              ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
              return;
            }

            if (identifiedAgentId && identifiedAgentId !== msg.agentId) {
              const previousWs = this.agentWsMap.get(identifiedAgentId);
              if (previousWs === ws) {
                this.agentWsMap.delete(identifiedAgentId);
              }
            }

            const existingWs = this.agentWsMap.get(msg.agentId);
            if (existingWs && existingWs !== ws) {
              this.agentWsMap.delete(msg.agentId);
              try {
                existingWs.close(4001, "Superseded by a newer registry connection");
              } catch {
                existingWs.terminate();
              }
            }

            identifiedAgentId = msg.agentId;
            // Stamp the agentId on the WS itself so the keepalive interval
            // (which iterates wss.clients, not agentWsMap) can evict the
            // routing entry in O(1) when a zombie is terminated.
            (ws as any)._identifiedAgentId = msg.agentId;
            this.agentWsMap.set(msg.agentId, ws);
            console.error(`[Registry WS] Agent identified: ${msg.agentId}`);

            // Clean up only truly superseded/dead entries (same sessionId, dead local
            // orphan, or disconnected legacy entry) — concurrent live sessions coexist.
            const identifiedEntry = this.store.get(msg.agentId);
            if (identifiedEntry?.entryType === "client" && identifiedEntry.clientInfo?.clientName) {
              for (const other of this.store.list()) {
                if (other.agentId === msg.agentId) continue;
                const otherWs = this.agentWsMap.get(other.agentId);
                const otherWsLive = Boolean(otherWs && otherWs.readyState === WebSocket.OPEN);
                if (!shouldReplaceRegistryEntry(other, identifiedEntry, { existingHasLiveWs: otherWsLive })) {
                  continue;
                }
                this.store.deregister(other.agentId);
                if (otherWs) {
                  this.agentWsMap.delete(other.agentId);
                  try { otherWs.close(4001, "Superseded"); } catch { otherWs.terminate(); }
                }
              }
            }

            ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
            return;
          }

          // Agent-to-agent message relay
          if (msg.type === "agent.message" && msg.data?.toAgentId) {
            this.sendToAgent(msg.data.toAgentId, msg);
            // Broadcast to observer WS subscribers too
            this.eventBus.broadcast({
              type: "agent.message",
              timestamp: new Date().toISOString(),
              data: msg.data,
            });
          }
        } catch {
          // Ignore parse errors from non-JSON messages
        }
      });

      ws.on("close", () => {
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
            const entry = this.store.get(identifiedAgentId);
            if (entry?.entryType === "client") {
              // Client sessions are bound to their CLI process. Remove immediately on WS drop
              // so list_agents and registry queries never show a zombie entry when the CLI dies.
              this.store.deregister(identifiedAgentId);
            } else {
              // Agents may still serve HTTP after losing their WS — just mark unhealthy so the
              // registry reflects the disconnect without waiting 2 minutes for the health check.
              this.store.markUnhealthy(identifiedAgentId);
            }
            console.error(`[Registry WS] Disconnected: ${identifiedAgentId}`);
          }
        }
      });

      ws.on("error", (err) => {
        console.error(`[Registry WS] Error: ${err.message}`);
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
            const entry = this.store.get(identifiedAgentId);
            if (entry?.entryType === "client") {
              this.store.deregister(identifiedAgentId);
            } else {
              this.store.markUnhealthy(identifiedAgentId);
            }
          }
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use — another registry (or process) is bound to it. Stop it, or start on a different port with --port.`));
        } else {
          reject(err);
        }
      };
      this.httpServer!.once("error", onError);
      this.httpServer!.listen(this.port, "localhost", () => {
        this.httpServer!.removeListener("error", onError);
        resolve();
      });
    });

    this.healthCheckTimer = setInterval(() => {
      this.store.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Ack sweeper: every minute, mark as `failed` any message that requested a
    // response, has passed its expiresAt deadline, and never reached a terminal
    // ack. This unblocks senders waiting on the conversation state machine and
    // gives subscribers a definitive end-state instead of a "pending forever".
    this.ackSweepTimer = setInterval(() => this.sweepExpiredAcks(), ACK_SWEEP_INTERVAL_MS);

    // Conversation cleanup: hourly, delete conversations whose last activity is
    // older than the retention window. Bounds SQLite growth on long-running
    // registries without affecting any active conversation.
    this.conversationCleanupTimer = setInterval(
      () => this.sweepStaleConversations(),
      CONVERSATION_CLEANUP_INTERVAL_MS,
    );

    // Terminal sweep: every few minutes, delete answered/failed threads older
    // than the short terminal-retention window so resolved traffic can't
    // saturate inboxes or slow the per-call conversation scan.
    this.terminalSweepTimer = setInterval(
      () => this.sweepTerminalConversations(),
      TERMINAL_SWEEP_INTERVAL_MS,
    );

    console.error(`[Registry] Listening on http://localhost:${this.port}`);
  }

  /** Send a payload directly to the WS mapped for `agentId`. Returns false and
   *  evicts the entry from `agentWsMap` if the socket is missing, not OPEN, or
   *  the synchronous send throws. The keepalive interval still catches zombies
   *  whose readyState wrongly reports OPEN within ~30 s, but this helper covers
   *  the cases visible at send time without waiting for the next ping cycle. */
  private sendToAgent(agentId: string, payload: unknown): boolean {
    const ws = this.agentWsMap.get(agentId);
    if (!ws) return false;
    if (ws.readyState !== WebSocket.OPEN) {
      this.agentWsMap.delete(agentId);
      return false;
    }
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.agentWsMap.delete(agentId);
      console.error(`[Registry] sendToAgent(${agentId}) failed, evicted: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private sweepStaleConversations(): void {
    try {
      const cutoff = Date.now() - CONVERSATION_RETENTION_MS;
      const removed = this.channelStore.deleteConversationsOlderThan(cutoff);
      if (removed > 0) {
        console.error(`[Registry] Cleanup removed ${removed} stale conversation(s) older than ${CONVERSATION_RETENTION_MS / (24 * 60 * 60_000)} day(s)`);
      }
    } catch (err: unknown) {
      console.error("[Registry] Conversation cleanup failed:", err instanceof Error ? err.message : err);
    }
  }

  private sweepTerminalConversations(): void {
    try {
      const cutoff = Date.now() - TERMINAL_RETENTION_MS;
      const removed = this.channelStore.deleteTerminalConversationsOlderThan(cutoff);
      if (removed > 0) {
        console.error(`[Registry] Terminal sweep removed ${removed} resolved conversation(s) older than ${TERMINAL_RETENTION_MS / 60_000} min`);
      }
    } catch (err: unknown) {
      console.error("[Registry] Terminal sweep failed:", err instanceof Error ? err.message : err);
    }
  }

  private sweepExpiredAcks(): void {
    try {
      const expired = this.channelStore.findExpiredAwaitingReply(Date.now());
      if (expired.length === 0) return;
      for (const message of expired) {
        const ack = this.channelStore.addAck({
          conversationId: message.conversationId,
          messageId: message.messageId,
          state: "failed",
          actorId: "registry",
          actorType: "registry",
          timestamp: Date.now(),
          detail: "Expired without reply (registry sweeper)",
        });
        this.eventBus.broadcast({
          type: "channel.ack",
          timestamp: new Date().toISOString(),
          data: ack,
        });
      }
      console.error(`[Registry] Ack sweeper marked ${expired.length} expired message(s) as failed`);
    } catch (err: unknown) {
      console.error("[Registry] Ack sweeper failed:", err instanceof Error ? err.message : err);
    }
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.ackSweepTimer) {
      clearInterval(this.ackSweepTimer);
    }
    if (this.conversationCleanupTimer) {
      clearInterval(this.conversationCleanupTimer);
    }
    if (this.terminalSweepTimer) {
      clearInterval(this.terminalSweepTimer);
    }

    // Close all WS clients
    for (const ws of this.wsClients) {
      ws.terminate();
    }
    this.wsClients.clear();
    this.wss?.close();
    this.wss = null;
    this.channelStore.close();

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
