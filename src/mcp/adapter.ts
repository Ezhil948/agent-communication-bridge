/**
 * MCP Adapter — Bridges the channel system as MCP tools for Antigravity (`agy`),
 * OpenAI Codex (`codex`), and OpenCode (`opencode`).
 *
 * AUTO MODE (default):
 *   If no registry is running at localhost:4999, starts one in-process.
 *   Also auto-starts a local agent for the current working directory.
 *
 * Exposed tools:
 *   agent_bridge_guide     — read the Triad MCP usage guide
 *   list_agents            — discover connected agents and client sessions
 *   message_client_session — send a channel message to a client session
 *   reply                  — reply to an incoming channel message
 *   channel_inbox          — inspect pending channel conversations
 *   channel_clear          — clear handled conversations from the inbox
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { detectProjectType } from "../agent/project-detector.js";
import { fileUriToFsPath, normalizePathKey, pathsEqual } from "../utils/path.js";
import { localCorsMiddleware } from "../utils/http.js";
import { RegistryClient } from "../client/registry-client.js";
import { ChannelTransport } from "../client/channel-transport.js";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import { ConversationService } from "../client/conversation-service.js";
import { DefaultClientProfileResolver, type ClientBehaviorProfile } from "../client/client-profile-resolver.js";
import { BoundedIdSet } from "../client/bounded-id-set.js";
import { buildInjectionPrompt } from "../client/injection-prompt.js";
import { loadPromptTemplate } from "../client/prompt-template.js";
import { codexDaemonSocketPath, deliverViaCodexDaemon } from "../client/codex-daemon-socket.js";
import { deliverViaHostInboxSocket, parentHostInboxSocket } from "../client/host-inbox-socket.js";
import { readAgyConversation, sendUserCascadeMessage } from "../client/antigravity-ls-client.js";
import {
  type AncestorProcessCommandEntry,
  getAncestorCommandEntries,
  isPluginInstallPath,
  resolveWorkspaceFromAncestors,
} from "../client/workspace-discovery.js";
import { selectConversationsToClear } from "./clear-scope.js";
import { buildAgentBridgeGuide } from "./guide-content.js";
import {
  buildStableClientAgentId,
  findPairedBridgeAgent,
  formatAgentsSummary,
  getPeerType,
  getPeerTypeLabel,
  inferExpectsResponse,
  type PeerType,
} from "./peer-classifier.js";
import { RegistryServer } from "../registry/server.js";
import type { RegistryEntry, AgentMessage, ChannelMessage, AgentRegistration } from "../types/messages.js";

export {
  buildStableClientAgentId,
  getPeerType,
  getPeerTypeLabel,
  inferExpectsResponse,
  type PeerType,
};

export interface McpAdapterOptions {
  registryUrl?: string;
  /** Auto-start registry if none found (default: true) */
  auto?: boolean;
  /** Project path used for client registration (default: cwd) */
  projectPath?: string;
  /** True when `projectPath` was pinned via `--project` or `AGENT_BRIDGE_PROJECT`. */
  projectPathExplicit?: boolean;
  /** Channel namespace for this session (default: "global") */
  identity?: string;
  /** Optional explicit session ID (defaults to a fresh UUID per adapter instance). */
  sessionId?: string;
  /** Optional injected ancestor entries (primarily for deterministic tests). */
  ancestorEntries?: AncestorProcessCommandEntry[];
}

export interface ClientCapabilitiesSnapshot {
  sampling?: unknown;
  elicitation?: unknown;
  roots?: unknown;
  [key: string]: unknown;
}

export class McpAgentBridge {
  private server: McpServer;
  private registry: RegistryClient;
  private channelTransport: ChannelTransport;
  private channelRuntime: ChannelClientRuntime;
  private conversationService: ConversationService;
  private readonly profileResolver = new DefaultClientProfileResolver();
  private clientProfile: ClientBehaviorProfile;
  private options: {
    registryUrl: string;
    auto: boolean;
    projectPath: string;
    identity: string;
  };
  private readonly sessionId: string;
  private readonly projectPathExplicit: boolean;
  private readonly injectedAncestors?: AncestorProcessCommandEntry[];
  private ancestorEntries: AncestorProcessCommandEntry[] = [];
  private ancestorPids: number[] = [];
  private ancestorEntriesLoaded = false;
  private registerSignalHandlers = true;
  private initializedClientInfo: { clientName: string; clientVersion: string } | null = null;
  private clientAgentId: string | null = null;
  private clientActivating = false;
  private clientCapabilities: ClientCapabilitiesSnapshot = {};
  private embeddedRegistry: RegistryServer | null = null;
  private surfacedInboxMessageIds = new BoundedIdSet(5_000);
  private codexDeliveries: Promise<boolean> = Promise.resolve(true);
  private pendingPreInitMessages: ChannelMessage[] = [];
  private syncInFlight = false;
  private siblingBridgeAgentIds: Set<string> = new Set();
  private resolvedProjectPath: string = process.cwd();
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  private delayedSyncTimer: NodeJS.Timeout | null = null;

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: options.registryUrl ?? "http://localhost:4999",
      auto: options.auto ?? true,
      projectPath: options.projectPath ?? process.cwd(),
      identity: options.identity ?? process.env["AGENT_BRIDGE_IDENTITY"] ?? "global",
    };
    this.sessionId = options.sessionId ?? randomUUID();
    this.projectPathExplicit = options.projectPathExplicit ?? Boolean(options.projectPath);
    this.injectedAncestors = options.ancestorEntries;
    this.resolvedProjectPath = this.options.projectPath;
    this.registry = new RegistryClient(this.options.registryUrl);
    this.channelTransport = new ChannelTransport({ registryUrl: this.options.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
    });
    this.conversationService = new ConversationService(this.channelRuntime);
    this.clientProfile = this.profileResolver.resolve({ clientName: "codex" });

    this.server = new McpServer(
      {
        name: "agent-communication-bridge",
        version: "1.0.0",
      },
      {
        capabilities: {
          logging: {},
          experimental: {},
        },
        instructions: [
          "Connected to agent-communication-bridge — Triad channel messaging between Antigravity (agy), Codex, and OpenCode sessions.",
          "Load the `agent-bridge` skill (or call `agent_bridge_guide`) before using these tools for workflow and routing semantics.",
          "",
          "Tools:",
          "- `agent_bridge_guide(topic?)` — full workflow, peer types, `expectsResponse`, ACKs, troubleshooting.",
          "- `list_agents(includeClients=true)` — discover peers (`[Antigravity inner]`, `[Codex inner]`, `[OpenCode]`).",
          "- `message_client_session(clientId | project, message, expectsResponse?)` — send a message to a peer.",
          "- `channel_inbox(pendingOnly=true)` — list conversations awaiting reply, each with a `replyWith` block.",
          "- `reply(agentId, conversationId, replyTo, message)` — answer a pending message (copy `replyWith` fields verbatim).",
        ].join("\n"),
      },
    );

    this.setupChannelRuntime();
  }

  private async prepareBridgeSession(): Promise<void> {
    if (this.options.auto) {
      await this.ensureInfrastructure();
    }

    await this.loadAncestorEntries();
    if (!this.projectPathExplicit && isPluginInstallPath(this.options.projectPath)) {
      const discovered = await this.discoverWorkspaceProjectPath();
      if (discovered) {
        this.resolvedProjectPath = discovered;
      }
    }

    const initialProjectPath = this.resolvedProjectPath;
    const defaultAgentId = this.buildStableClientAgentId(
      "mcp-client",
      initialProjectPath,
      this.options.identity,
    );
    const defaultName = basename(initialProjectPath);
    const placeholderRegistration = await this.buildClientRegistration({
      agentId: defaultAgentId,
      clientName: "mcp-client",
      clientVersion: "1.0.0",
      projectPath: initialProjectPath,
      projectName: defaultName,
      description: `MCP client — ${defaultName}`,
    });

    await this.channelRuntime.activateClient(placeholderRegistration);

    await this.syncRegistryToLocalStore();
    this.startPeriodicSync();

    this.channelRuntime.on("ws.open", () => {
      void this.syncRegistryToLocalStore();
    });

    this.registerMetaTools();
  }

  /** Attach an arbitrary MCP Transport (primarily used by in-memory integration tests). */
  async startWithTransport(transport: Transport): Promise<void> {
    this.registerSignalHandlers = false;
    await this.prepareBridgeSession();
    this.setupClientDetection();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    this.clearSyncTimers();
    this.surfacedInboxMessageIds.clear();
    await this.channelRuntime.destroyRuntime();
    this.clientAgentId = null;
    if (this.embeddedRegistry) {
      try {
        await this.embeddedRegistry.stop();
      } catch {
        /* ignore */
      }
      this.embeddedRegistry = null;
    }
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    await this.prepareBridgeSession();

    if (transport === "stdio") {
      this.setupClientDetection();
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error("[MCP] agent-communication-bridge MCP server ready (stdio)");
    } else {
      await this.startHttpTransport(httpPort);
    }
  }

  private setupChannelRuntime(): void {
    this.channelRuntime.on("channel.message", (channelMessage) => {
      if (this.clientAgentId && channelMessage.fromAgentId === this.clientAgentId) return;

      if (!this.clientAgentId) {
        if ((channelMessage.identity ?? "global") !== this.options.identity) return;
        this.pendingPreInitMessages.push(channelMessage);
        return;
      }

      if (
        !this.clientProfile.acceptsChannelMessage(channelMessage, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
          selfIdentity: this.options.identity,
        })
      ) {
        return;
      }
      this.deliverChannelMessage(channelMessage);
    });

    this.channelRuntime.on("legacy.notify", (notify) => {
      const notification = this.clientProfile.mapLegacyNotify(notify);
      if (!notification) return;
      void this.server.server.notification(notification);
    });

    this.channelRuntime.on("agent.message", (agentMsg) => {
      if (agentMsg.type === "task.request") {
        if (!this.clientAgentId || agentMsg.toAgentId !== this.clientAgentId) return;
        const notification = this.clientProfile.mapTaskRequestMessage(agentMsg as AgentMessage);
        if (!notification) return;
        void this.server.server.notification(notification);
      }
    });
  }

  private deliverChannelMessage(channelMessage: ChannelMessage): void {
    if (this.surfacedInboxMessageIds.has(channelMessage.messageId)) return;

    const isPassiveInnerClientMirror =
      (this.clientProfile.id === "codex" || this.clientProfile.id === "antigravity") &&
      typeof channelMessage.toAgentId === "string" &&
      this.siblingBridgeAgentIds.has(channelMessage.toAgentId);

    if (!isPassiveInnerClientMirror) {
      void this.postChannelAck({
        conversationId: channelMessage.conversationId,
        messageId: channelMessage.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "mcp-adapter",
        actorType: "bridge",
        detail: "Message received by MCP bridge",
      });
    }

    const notification = this.clientProfile.mapChannelMessage(channelMessage);
    if (!notification) return;

    const injectTurn = (
      deliver: (prompt: string) => Promise<boolean>,
      detail: string,
      { notifyOnFailure = true }: { notifyOnFailure?: boolean } = {},
    ) => {
      this.surfacedInboxMessageIds.add(channelMessage.messageId);
      const prompt = buildInjectionPrompt(channelMessage, {
        replyTool: "reply (agent-communication-bridge MCP tool)",
        template: loadPromptTemplate(),
      });
      void deliver(prompt).then((delivered) => {
        if (!delivered) {
          this.surfacedInboxMessageIds.delete(channelMessage.messageId);
          if (notifyOnFailure) this.pushNotificationAndAck(notification, channelMessage, isPassiveInnerClientMirror);
        } else if (!isPassiveInnerClientMirror) {
          void this.postChannelAck({
            conversationId: channelMessage.conversationId,
            messageId: channelMessage.messageId,
            state: "displayed_to_client",
            actorId: this.clientAgentId ?? "mcp-adapter",
            actorType: "bridge",
            detail,
          });
        }
      });
    };

    const ownedBySiblingBridge =
      isPassiveInnerClientMirror || (!channelMessage.toAgentId && this.siblingBridgeAgentIds.size > 0);

    const model = typeof channelMessage.meta?.["model"] === "string" ? channelMessage.meta["model"] : undefined;
    const reasoning =
      typeof channelMessage.meta?.["reasoning"] === "string" ? channelMessage.meta["reasoning"] : undefined;

    // 1. Codex native push via app-server daemon (codex-cli ≥ 0.162)
    if (this.clientProfile.id === "codex" && !ownedBySiblingBridge && codexDaemonSocketPath()) {
      injectTurn(
        (prompt) => {
          const delivery = this.codexDeliveries.then(() =>
            deliverViaCodexDaemon(prompt, {
              cwd: this.resolvedProjectPath,
              model,
              effort: reasoning,
            }),
          );
          this.codexDeliveries = delivery;
          return delivery;
        },
        "Message injected into the live Codex session via the app-server daemon",
        { notifyOnFailure: false },
      );
      return;
    }

    // 2. Antigravity native push via language server (`SendUserCascadeMessage`)
    const agyConversation =
      this.clientProfile.id === "antigravity" && !ownedBySiblingBridge
        ? readAgyConversation(process.ppid, process.env, this.resolvedProjectPath)
        : undefined;
    if (agyConversation) {
      injectTurn(
        (prompt) =>
          sendUserCascadeMessage(agyConversation, agyConversation.cascadeId, prompt, {
            model,
            reasoning,
          }).catch(() => false),
        "Message sent to the live agy conversation",
        { notifyOnFailure: false },
      );
      return;
    }

    // 3. OpenCode native push via host inbox socket
    const hostInbox =
      this.clientProfile.id === "opencode" && !ownedBySiblingBridge
        ? parentHostInboxSocket(process.env, this.resolvedProjectPath)
        : null;
    if (hostInbox) {
      injectTurn(
        (prompt) =>
          deliverViaHostInboxSocket(prompt, {
            socketPath: hostInbox,
            id: channelMessage.messageId,
            meta: { model, reasoning },
          }),
        "Message written to the opencode session inbox socket",
        { notifyOnFailure: false },
      );
      return;
    }

    if (this.clientProfile.id === "antigravity" && !ownedBySiblingBridge) return;

    this.pushNotificationAndAck(notification, channelMessage, isPassiveInnerClientMirror);
  }

  private pushNotificationAndAck(
    notification: { method: string; params: Record<string, unknown> },
    channelMessage: ChannelMessage,
    isPassiveInnerClientMirror: boolean,
  ): void {
    void this.tryPushNotification(notification, channelMessage).then((success) => {
      if (success) {
        this.surfacedInboxMessageIds.add(channelMessage.messageId);
        if (!isPassiveInnerClientMirror) {
          void this.postChannelAck({
            conversationId: channelMessage.conversationId,
            messageId: channelMessage.messageId,
            state: "displayed_to_client",
            actorId: this.clientAgentId ?? "mcp-adapter",
            actorType: "bridge",
            detail: "Message forwarded to client channel",
          });
        }
      }
    });
  }

  private async tryPushNotification(
    notification: { method: string; params: Record<string, unknown> },
    channelMessage: ChannelMessage,
    maxRetries = 5,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.server.server.notification(notification);
        return true;
      } catch (err) {
        console.error(
          `[MCP] Notification push failed (attempt ${attempt}/${maxRetries}) for message ${channelMessage.messageId}: ${String(err)}`,
        );
        if (attempt < maxRetries) {
          const delay = Math.min(250 * Math.pow(2, attempt - 1), 5_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    console.error(
      `[MCP] Notification push permanently failed for message ${channelMessage.messageId}. ` +
        `Will retry via delayed sync; message stays in inbox: ${channelMessage.conversationId}`,
    );
    this.scheduleDelayedSync(15_000);
    return false;
  }

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    this.clearSyncTimers();
    this.periodicSyncTimer = setInterval(() => {
      void this.syncRegistryToLocalStore();
    }, periodMs);
    this.periodicSyncTimer.unref?.();
  }

  private scheduleDelayedSync(delayMs: number): void {
    if (this.delayedSyncTimer) return;
    this.delayedSyncTimer = setTimeout(() => {
      this.delayedSyncTimer = null;
      void this.syncRegistryToLocalStore();
    }, delayMs);
    this.delayedSyncTimer.unref?.();
  }

  private clearSyncTimers(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.delayedSyncTimer) {
      clearTimeout(this.delayedSyncTimer);
      this.delayedSyncTimer = null;
    }
  }

  private drainPendingPreInitMessages(): void {
    if (this.pendingPreInitMessages.length === 0) return;
    const queued = this.pendingPreInitMessages.splice(0);
    for (const msg of queued) {
      if (this.clientAgentId && msg.fromAgentId === this.clientAgentId) continue;
      if (
        !this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
          selfIdentity: this.options.identity,
        })
      ) {
        continue;
      }
      this.deliverChannelMessage(msg);
    }
  }

  private async refreshSiblingBridgeAgentIds(projectPath: string): Promise<void> {
    try {
      const all = await this.registry.listAgents();
      const selfIdentity = this.options.identity ?? "global";
      const selfEntry: RegistryEntry = {
        agentId: this.clientAgentId ?? "self",
        name: basename(projectPath),
        url: "",
        wsUrl: "",
        port: 0,
        projectPath,
        projectName: basename(projectPath),
        projectType: "unknown",
        card: {
          name: basename(projectPath),
          description: "",
          url: "",
          version: "1.0.0",
          protocolVersion: "0.3.0",
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [],
        },
        registeredAt: 0,
        entryType: "client",
        identity: selfIdentity,
        sessionId: this.sessionId,
        ancestorPids: this.ancestorPids,
        clientInfo: this.initializedClientInfo ?? {
          clientName: this.clientProfile.id,
          clientVersion: "1.0.0",
        },
        lastHeartbeat: 0,
        healthy: true,
      };
      const paired = findPairedBridgeAgent(selfEntry, all);
      this.siblingBridgeAgentIds = paired ? new Set([paired.agentId]) : new Set();
    } catch {
      // Keep previous set on transient registry error
    }
  }

  private async syncRegistryToLocalStore(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      if (
        this.initializedClientInfo &&
        !this.projectPathExplicit &&
        isPluginInstallPath(this.resolvedProjectPath)
      ) {
        const healedProject = await this.discoverWorkspaceProjectPath();
        if (healedProject && !pathsEqual(healedProject, this.resolvedProjectPath)) {
          const { clientName, clientVersion } = this.initializedClientInfo;
          const healedName = basename(healedProject);
          this.resolvedProjectPath = healedProject;
          this.clientAgentId = this.buildStableClientAgentId(
            clientName,
            healedProject,
            this.options.identity,
          );
          const registration = await this.buildClientRegistration({
            agentId: this.clientAgentId,
            clientName,
            clientVersion,
            projectPath: healedProject,
            projectName: healedName,
          });
          await this.channelRuntime.activateClient(registration);
        }
      }
      await this.refreshSiblingBridgeAgentIds(this.resolvedProjectPath);
      const snapshots = await this.registry.getChannelSnapshots();
      for (const snapshot of snapshots) {
        const accepted = snapshot.messages.filter((m) =>
          this.clientProfile.acceptsChannelMessage(m, this.clientAgentId, {
            siblingBridgeAgentIds: this.siblingBridgeAgentIds,
            selfIdentity: this.options.identity,
          }),
        );
        if (accepted.length > 0) {
          const acceptedIds = new Set(accepted.map((m) => m.messageId));
          const matchingAcks = snapshot.acknowledgements.filter((a) => acceptedIds.has(a.messageId));
          this.channelRuntime.seedFromSnapshot(accepted, matchingAcks);

          const seededConv = this.channelRuntime.getConversation(snapshot.conversationId);
          if (seededConv?.awaitingReply) {
            const pendingMsgs = this.channelRuntime.listPendingConversationMessages(snapshot.conversationId);
            for (const pendingMsg of pendingMsgs) {
              if (this.clientAgentId && pendingMsg.fromAgentId === this.clientAgentId) continue;
              this.deliverChannelMessage(pendingMsg);
            }
          }
        }
      }
    } catch {
      // Registry unreachable — keep existing local state
    } finally {
      this.syncInFlight = false;
    }
  }

  private async postChannelAck(ack: {
    conversationId: string;
    messageId: string;
    state: "delivered_to_bridge" | "displayed_to_client" | "answered" | "failed";
    actorId: string;
    actorType: "bridge" | "client";
    detail?: string;
  }): Promise<void> {
    try {
      await this.channelRuntime.acknowledgeMessage(ack);
    } catch {
      // Non-fatal
    }
  }

  private async ensureInfrastructure(): Promise<void> {
    const registryUp = await this.registry.isAvailable();
    if (!registryUp) {
      console.error("[MCP] No registry found at localhost:4999 — starting embedded registry...");
      this.embeddedRegistry = new RegistryServer();
      await this.embeddedRegistry.start();
    }
  }

  private setupClientDetection(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (this.server as unknown as { server: any }).server;
    if (!innerServer) return;

    innerServer.oninitialized = async () => {
      try {
        if (this.clientAgentId || this.clientActivating) {
          console.error("[MCP] Ignoring duplicate oninitialized");
          return;
        }

        const clientVersion = innerServer.getClientVersion?.();
        if (!clientVersion?.name) return;

        this.clientActivating = true;

        const clientName: string = clientVersion.name;
        const version: string = clientVersion.version ?? "unknown";
        this.initializedClientInfo = { clientName, clientVersion: version };
        this.clientProfile = this.profileResolver.resolve({ clientName });

        try {
          const caps = innerServer.getClientCapabilities?.() ?? {};
          this.clientCapabilities = caps as ClientCapabilitiesSnapshot;
          const summary = {
            clientName,
            version,
            sampling: Boolean((caps as Record<string, unknown>).sampling),
            elicitation: Boolean((caps as Record<string, unknown>).elicitation),
            roots: Boolean((caps as Record<string, unknown>).roots),
            raw: caps,
          };
          console.error(`[MCP] client capabilities: ${JSON.stringify(summary)}`);
          const safeName = clientName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          const capsDir = join(homedir(), ".gemini", "antigravity-cli");
          mkdirSync(capsDir, { recursive: true });
          writeFileSync(
            join(capsDir, `acb-caps-${safeName}.json`),
            `${JSON.stringify(summary, null, 2)}\n`,
            "utf8",
          );
        } catch (err) {
          console.error(`[MCP] capability probe failed: ${String(err)}`);
        }

        await this.loadAncestorEntries();
        let realProjectPath = this.resolvedProjectPath;
        let realProjectName = basename(realProjectPath);
        const capabilities = innerServer.getClientCapabilities?.();
        let resolvedFromRoots = false;
        if (!this.projectPathExplicit && capabilities?.roots) {
          try {
            const rootsResult = await innerServer.listRoots();
            if (rootsResult.roots?.length > 0) {
              const firstRoot = rootsResult.roots[0];
              if (firstRoot.uri.startsWith("file://")) {
                const candidateRoot = fileUriToFsPath(firstRoot.uri);
                if (candidateRoot && !isPluginInstallPath(candidateRoot)) {
                  realProjectPath = candidateRoot;
                  realProjectName = firstRoot.name || basename(realProjectPath);
                  resolvedFromRoots = true;
                }
              }
            }
          } catch {
            // Fall back to ancestor discovery / configured projectPath
          }
        }

        if (
          !this.projectPathExplicit &&
          !resolvedFromRoots &&
          (this.clientProfile.id === "antigravity" || isPluginInstallPath(realProjectPath))
        ) {
          const discovered = await this.discoverWorkspaceProjectPath();
          if (discovered) {
            realProjectPath = discovered;
            realProjectName = basename(realProjectPath);
          }
        }

        this.clientAgentId = this.buildStableClientAgentId(
          clientName,
          realProjectPath,
          this.options.identity,
        );
        this.resolvedProjectPath = realProjectPath;

        const registration = await this.buildClientRegistration({
          agentId: this.clientAgentId,
          clientName,
          clientVersion: version,
          projectPath: realProjectPath,
          projectName: realProjectName,
        });

        await this.channelRuntime.activateClient(registration);
        await this.syncRegistryToLocalStore();
        this.drainPendingPreInitMessages();
        console.error(`[MCP] Registered client: ${realProjectName} (${clientName} v${version})`);

        if (this.clientProfile.id === "opencode") {
          await this.autoCreateChannels(registration);
        }

        if (this.registerSignalHandlers) {
          const cleanup = () => void this.stop();
          process.once("SIGINT", cleanup);
          process.once("SIGTERM", cleanup);
          process.once("beforeExit", cleanup);
        }
      } catch (err) {
        this.clientActivating = false;
        console.error("[MCP] Failed to register client:", err);
      }
    };
  }

  private async loadAncestorEntries(): Promise<AncestorProcessCommandEntry[]> {
    if (this.ancestorEntriesLoaded) return this.ancestorEntries;
    this.ancestorEntriesLoaded = true;
    this.ancestorEntries = this.injectedAncestors ?? (await getAncestorCommandEntries());
    this.ancestorPids = this.ancestorEntries.map((entry) => entry.pid);
    return this.ancestorEntries;
  }

  private async discoverWorkspaceProjectPath(): Promise<string | undefined> {
    const ancestors = await this.loadAncestorEntries();
    return resolveWorkspaceFromAncestors({
      ancestors,
      readAgyProject: (pid) => readAgyConversation(pid, process.env)?.projectPath,
    });
  }

  private async buildClientRegistration(input: {
    agentId: string;
    clientName: string;
    clientVersion: string;
    projectPath: string;
    projectName?: string;
    description?: string;
  }): Promise<AgentRegistration> {
    const projectName = input.projectName ?? basename(input.projectPath);
    let projectType = "unknown";
    try {
      projectType = (await detectProjectType(input.projectPath)).type;
    } catch {
      // Unreadable project dir — keep "unknown"
    }
    return {
      agentId: input.agentId,
      name: projectName,
      url: "",
      wsUrl: "",
      port: 0,
      projectPath: input.projectPath,
      projectName,
      projectType,
      card: {
        name: projectName,
        description:
          input.description ?? `AI client: ${input.clientName} v${input.clientVersion} — ${projectName}`,
        url: "",
        version: input.clientVersion,
        protocolVersion: "0.3.0",
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: [],
      },
      registeredAt: Date.now(),
      entryType: "client",
      identity: this.options.identity,
      sessionId: this.sessionId,
      ancestorPids: this.ancestorPids,
      clientInfo: { clientName: input.clientName, clientVersion: input.clientVersion },
    };
  }

  private buildStableClientAgentId(
    clientName: string,
    projectPath: string,
    identity?: string,
  ): string {
    return buildStableClientAgentId(clientName, projectPath, identity, this.sessionId);
  }

  private async autoCreateChannels(registration: AgentRegistration): Promise<void> {
    try {
      const all = await this.registry.listAgents();
      const selfId = registration.agentId;
      const selfIdentity = registration.identity ?? "global";
      const peers = all.filter(
        (e) =>
          e.agentId !== selfId &&
          (e.identity ?? "global") === selfIdentity,
      );

      if (peers.length === 0) {
        console.error("[MCP] OpenCode auto-channels: no peers found");
        return;
      }

      for (const peer of peers) {
        const conversationId = this.buildDeterministicConversationId(selfId, peer.agentId);
        const existing = this.channelRuntime.getConversation(conversationId);
        if (existing) continue;

        try {
          await this.channelRuntime.sendMessage({
            conversationId,
            toAgentId: peer.agentId,
            kind: "presence",
            content: `${registration.name} (OpenCode) is now connected`,
            expectsResponse: false,
            requiresAck: false,
          });
        } catch (err) {
          console.error(
            `[MCP] OpenCode auto-channel to ${peer.agentId.slice(0, 16)} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      console.error(`[MCP] OpenCode auto-channels: created ${peers.length} channel(s)`);
    } catch (err) {
      console.error(
        "[MCP] OpenCode auto-channel creation failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private buildDeterministicConversationId(agentIdA: string, agentIdB: string): string {
    const sorted = [agentIdA, agentIdB].sort().join("\n");
    const hex = createHash("sha1").update(sorted).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private registerMetaTools(): void {
    this.registerGuideTools();
    this.registerDiscoveryTools();
    this.registerConversationManagementTools();
    this.registerChannelMessagingTools();
  }

  private registerGuideTools(): void {
    this.server.registerTool(
      "agent_bridge_guide",
      {
        description:
          "Read the agent-communication-bridge MCP usage guide for Antigravity, Codex, and OpenCode. " +
          "Use this when you need setup instructions, send/reply workflow, `expectsResponse` semantics, delivery ACK meanings, or troubleshooting.",
        inputSchema: {
          topic: z
            .enum(["overview", "setup", "send", "reply", "acks", "troubleshooting", "all"])
            .optional()
            .describe("Guide section to return (default: all)."),
        },
      },
      async ({ topic = "all" }) => ({
        content: [{ type: "text" as const, text: buildAgentBridgeGuide(topic) }],
      }),
    );
  }

  private registerDiscoveryTools(): void {
    this.server.registerTool(
      "list_agents",
      {
        description:
          "List all agents and client sessions connected to agent-communication-bridge. " +
          "Returns agentId, project path, health, skills, and client peer labels such as [Antigravity inner], [Codex inner], [OpenCode]. " +
          "WORKFLOW: call this first to discover targets before using message_client_session. " +
          "Pass includeClients=true to see Antigravity/Codex/OpenCode client sessions; bridge daemons are internal and routing to them is automatic.",
        inputSchema: {
          skill: z.string().optional().describe("Filter agents with this skill (e.g. 'endpoint-find')"),
          project: z.string().optional().describe("Filter by project name or path substring"),
          healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
          includeClients: z
            .boolean()
            .optional()
            .describe(
              "Include client sessions (Antigravity, Codex, OpenCode) that have no HTTP skills (default: false). Set true when looking for a session to message.",
            ),
        },
      },
      async ({ skill, project, healthyOnly = true, includeClients = false }) => {
        try {
          let agents = await this.registry.listAgents({
            skill,
            project,
            healthy: healthyOnly ? true : undefined,
          });
          const selfIdentity = this.options.identity ?? "global";
          agents = agents.filter(
            (a) => a.entryType !== "client" || (a.identity ?? "global") === selfIdentity,
          );
          if (!includeClients) {
            agents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
          }
          return { content: [{ type: "text" as const, text: formatAgentsSummary(agents) }] };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Registry not reachable at localhost:4999." }],
            isError: true,
          };
        }
      },
    );
  }

  private registerConversationManagementTools(): void {
    this.server.registerTool(
      "channel_inbox",
      {
        description:
          "Check this agent's channel inbox for pending inbound messages from other agents. " +
          "Returns conversations with a 'replyWith' field — pass those exact values to the reply tool. " +
          "WORKFLOW: (1) call channel_inbox to see pending messages, " +
          "(2) read the replyWith field of each pending conversation, " +
          "(3) call reply(replyWith.agentId, replyWith.conversationId, replyWith.replyTo, yourMessage). " +
          "Syncs automatically from the registry before returning so the view is always current.",
        inputSchema: {
          expiredOnly: z.boolean().optional().describe("Show only locally expired conversations awaiting reply"),
          pendingOnly: z
            .boolean()
            .optional()
            .describe("Show only conversations awaiting reply (default: true). Set false for the GLOBAL view of all tracked conversations."),
          limit: z
            .coerce.number()
            .optional()
            .describe("Max conversations returned (default: 25). Protects against context saturation when many are pending."),
          includeMessages: z
            .boolean()
            .optional()
            .describe(
              "Include each conversation's FULL message history (default: false — only previews + replyWith are returned). Set true to read full threads.",
            ),
        },
      },
      async ({ expiredOnly = false, pendingOnly = true, limit = 25, includeMessages = false }) => {
        try {
          await this.syncRegistryToLocalStore();

          const allConversations = expiredOnly
            ? this.conversationService.listExpiredSnapshots(limit)
            : pendingOnly
              ? this.conversationService.listPendingSnapshots()
              : this.conversationService.listRecentSnapshots(limit);

          const totalCount = allConversations.length;
          const conversations = allConversations.slice(0, limit);
          if (conversations.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: expiredOnly
                    ? "No expired channel conversations for this client."
                    : pendingOnly
                      ? "No pending channel conversations for this client."
                      : "No tracked channel conversations for this client.",
                },
              ],
            };
          }

          const allAgents: RegistryEntry[] = [];
          const agentById = new Map<string, RegistryEntry>();
          const selfIdentity = this.options.identity ?? "global";
          try {
            const listed = await this.registry.listAgents();
            allAgents.push(...listed);
            for (const entry of listed) {
              agentById.set(entry.agentId, entry);
            }
          } catch {
            // Fall through with empty list
          }

          const resolveReplyAgentId = (rawAgentId: string): string => {
            const entry = agentById.get(rawAgentId);
            if (!entry) return rawAgentId;
            if ((entry.identity ?? "global") !== selfIdentity) return rawAgentId;
            return findPairedBridgeAgent(entry, allAgents)?.agentId ?? rawAgentId;
          };

          const payload = conversations.map((snapshot) => {
            const latestInbound = snapshot.pendingMessages
              .filter((m) => m.fromAgentId !== this.clientAgentId)
              .at(-1);

            const routedReplyAgentId = latestInbound
              ? resolveReplyAgentId(latestInbound.fromAgentId)
              : undefined;

            const peerEntry = latestInbound ? agentById.get(latestInbound.fromAgentId) : undefined;
            const peerType: PeerType | undefined = peerEntry ? getPeerType(peerEntry) : undefined;
            const peerLabel = peerEntry ? getPeerTypeLabel(peerEntry) : undefined;

            return {
              conversationId: snapshot.conversation.conversationId,
              status: snapshot.status,
              awaitingReply: snapshot.conversation.awaitingReply,
              lastAckState: snapshot.conversation.lastAckState,
              lastUpdatedAt: snapshot.lastUpdatedAt,
              expiresAt: snapshot.lastMessage?.expiresAt,
              lastMessagePreview: snapshot.lastMessage?.content.slice(0, 160),
              ...(peerType ? { peerType, peerLabel } : {}),
              replyWith: latestInbound
                ? {
                    agentId: routedReplyAgentId!,
                    conversationId: snapshot.conversation.conversationId,
                    replyTo: latestInbound.messageId,
                    ...(peerType ? { peerType } : {}),
                    ...(routedReplyAgentId !== latestInbound.fromAgentId
                      ? { originalFromAgentId: latestInbound.fromAgentId }
                      : {}),
                  }
                : undefined,
              pendingMessages: snapshot.pendingMessages.map((message) => ({
                messageId: message.messageId,
                fromAgentId: message.fromAgentId,
                fromAgentName: message.fromAgentName,
                toAgentId: message.toAgentId,
                expiresAt: message.expiresAt,
                content: message.content,
              })),
              messages: includeMessages
                ? snapshot.messages.map((message) => ({
                    messageId: message.messageId,
                    fromAgentId: message.fromAgentId,
                    fromAgentName: message.fromAgentName,
                    toAgentId: message.toAgentId,
                    replyTo: message.replyTo,
                    content: message.content,
                    createdAt: message.createdAt,
                  }))
                : undefined,
            };
          });

          const view = expiredOnly ? "expired" : pendingOnly ? "pending" : "all";
          const truncated = totalCount > conversations.length;
          const result = {
            summary: {
              view,
              total: totalCount,
              shown: conversations.length,
              truncated,
              ...(truncated
                ? {
                    hint:
                      `Showing the ${conversations.length} most recent of ${totalCount}. ` +
                      "Use channel_clear({scope:'answered'|'failed'|'all'}) to clear handled threads so new ones surface, " +
                      "or raise `limit`. Use channel_inbox(pendingOnly=false) for the global view.",
                  }
                : {}),
            },
            conversations: payload,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "channel_clear",
      {
        description:
          "Clear handled conversations from THIS agent's inbox so a saturated inbox " +
          "never buries new messages. Suppresses them from channel_inbox (reversible " +
          "server-side) and drops them locally. NEVER clears still-unanswered " +
          "(pending) threads in bulk — only via an explicit conversationId. " +
          "Scopes: 'answered' (replied), 'failed' (failed + expired), 'all' (every " +
          "non-pending thread), or a specific conversationId.",
        inputSchema: {
          scope: z
            .string()
            .describe("'answered' | 'failed' | 'all' | a specific conversationId"),
        },
      },
      async ({ scope }) => {
        try {
          await this.syncRegistryToLocalStore();
          const tracked = this.conversationService
            .listRecentSnapshots(1000)
            .map((s) => ({ conversationId: s.conversation.conversationId, status: s.status }));
          const ids = selectConversationsToClear(tracked, scope);

          let cleared = 0;
          for (const id of ids) {
            try {
              await this.registry.suppressChannelConversation(id);
            } catch {
              // Best-effort
            }
            try {
              this.conversationService.deleteConversation(id);
            } catch {
              /* ignore */
            }
            cleared++;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Cleared ${cleared} conversation(s) from the inbox (scope: ${scope}).`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  private registerChannelMessagingTools(): void {
    this.server.registerTool(
      "message_client_session",
      {
        description:
          "Send a message to a client session (Antigravity, Codex, OpenCode). " +
          "Each pair of agents shares one thread: a new message continues it. " +
          "USE THIS when you want to proactively send a message or task to another agent. " +
          "DO NOT USE THIS to reply to a pending inbound message — use the reply tool for that instead. " +
          "\n\nWORKFLOW: (1) call list_agents(includeClients=true) to find the target's agentId, " +
          "(2) call message_client_session(clientId=<agentId>, message=<text>). " +
          "Target resolution order when clientId is not provided: " +
          "(a) conversationId participant lookup, (b) project name/path match; " +
          "when a project has multiple sessions, opencode > antigravity > codex (override with clientType). " +
          "\n\nDELIVERY SEMANTICS by target type — every target gets the message as a new turn in its live session:" +
          "\n  • Antigravity  → through agy's language server once attached; before that, the Stop hook delivers it at the end of the next turn." +
          "\n  • Codex        → through the app-server daemon into the live TUI (codex ≥ 0.162), or by the `acb codex start` bridge into its own thread." +
          "\n  • OpenCode     → the plugin queues it in the bridge session via its host inbox socket." +
          "\n\nRESPONSE SEMANTICS: set expectsResponse=true only when you need a reply; set false for FYI/fire-and-forget. " +
          "If omitted, the adapter infers it from the message text." +
          "\n\nROUTING: if you pass an inner Codex or OpenCode MCP-client agentId, " +
          "the adapter auto-redirects the message to the project's bridge daemon transparently.",
        inputSchema: {
          clientId: z
            .string()
            .optional()
            .describe("Exact agentId of the target client session (from list_agents). Most reliable — use this whenever possible."),
          project: z
            .string()
            .optional()
            .describe("Project name or path substring to resolve the target session. Use when you don't have the exact agentId."),
          clientType: z
            .string()
            .optional()
            .describe("Filter by client type when project matches multiple sessions: 'antigravity', 'codex', or 'opencode'. Ignored when clientId is set."),
          message: z.string().describe("Message text to send to the target session"),
          conversationId: z
            .string()
            .optional()
            .describe("Thread to continue. Leave blank to use the thread this pair of agents already shares."),
          replyTo: z
            .string()
            .optional()
            .describe("messageId to thread this message as a reply to (optional, for in-thread continuations)"),
          taskId: z.string().optional().describe("Optional task ID to associate with this conversation"),
          expectsResponse: z
            .boolean()
            .optional()
            .describe("Set true if you require a reply, false for fire-and-forget. If omitted, the adapter infers it from the message text."),
          timeoutMs: z
            .coerce.number()
            .optional()
            .describe("How long to wait for a reply before reporting timeout (ms, default: 300000). Only used when expectsResponse=true."),
          model: z
            .string()
            .optional()
            .describe("Optional model override for this turn (e.g. 'gpt-5.4' for Codex, 'provider/model' for OpenCode, or an Antigravity model id)."),
          reasoning: z
            .string()
            .optional()
            .describe("Optional reasoning/thinking level override for this turn (e.g. 'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra' for Codex, OpenCode variant id, or Antigravity thinkingEffort)."),
        },
      },
      async (input) => this.handleMessageClientSession(input),
    );

    this.server.registerTool(
      "reply",
      {
        description:
          "Reply to a pending inbound channel message from another agent and mark the thread as answered. " +
          "USE THIS when channel_inbox shows a pending message and you want to respond. " +
          "DO NOT USE THIS to initiate a new conversation — use message_client_session for that. " +
          "\n\nWORKFLOW: (1) call channel_inbox(pendingOnly=true), " +
          "(2) read the replyWith field of the conversation, " +
          "(3) call reply(agentId=replyWith.agentId, conversationId=replyWith.conversationId, replyTo=replyWith.replyTo, message=<your response>). " +
          "All three routing fields (agentId, conversationId, replyTo) are REQUIRED — copy them exactly from replyWith.",
        inputSchema: {
          agentId: z
            .string()
            .describe("The agentId of the sender you are replying to — MUST be replyWith.agentId from channel_inbox"),
          message: z.string().describe("Your reply text"),
          conversationId: z
            .string()
            .describe("The conversation thread ID — MUST be replyWith.conversationId from channel_inbox"),
          replyTo: z
            .string()
            .describe("The messageId you are replying to — MUST be replyWith.replyTo from channel_inbox"),
          taskId: z.string().optional().describe("Task ID associated with the conversation (optional)"),
          skillId: z.string().optional().describe("Optional fallback skill when using task invocation"),
        },
      },
      async ({ agentId, message, conversationId, replyTo, taskId, skillId }) => {
        try {
          await this.syncRegistryToLocalStore();

          let routedAgentId = agentId;
          try {
            const target = await this.resolveAgent(agentId);
            const deliverable = await this.resolveDeliverableTarget(target);
            routedAgentId = deliverable.agentId;
          } catch {
            // Keep original agentId if lookup fails
          }

          const replyResult = await this.conversationService.replyAndAcknowledge({
            agentId: routedAgentId,
            conversationId,
            replyTo,
            taskId,
            kind: "chat",
            message,
            meta: skillId ? { skillId } : undefined,
            requiresAck: true,
            expectsResponse: false,
            acknowledgementState: "answered",
            acknowledgementDetail: `Reply sent from ${this.clientProfile.id} session`,
          });

          const resolvedAgentId =
            replyResult.reply.message.toAgentId ??
            agentId ??
            replyResult.reply.resolvedContext?.toAgentId;

          if (!resolvedAgentId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "reply needs agentId, conversationId, and replyTo — use the replyWith field from channel_inbox.",
                },
              ],
              isError: true,
            };
          }

          let recipientName = resolvedAgentId;
          try {
            const entry = await this.resolveAgent(resolvedAgentId);
            recipientName = `${entry.name} (${entry.clientInfo?.clientName ?? resolvedAgentId})`;
          } catch {
            /* best-effort */
          }

          const channelMessage = replyResult.reply.message;
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Reply sent to: ${recipientName}`,
                  `  toAgentId:      ${resolvedAgentId}`,
                  `  conversationId: ${channelMessage.conversationId}`,
                  `  messageId:      ${channelMessage.messageId}`,
                  `  replyTo:        ${replyTo}`,
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  private async resolveDeliverableTarget(target: RegistryEntry): Promise<RegistryEntry> {
    try {
      const all = await this.registry.listAgents();
      const bridge = findPairedBridgeAgent(target, all);
      if (bridge) {
        const clientName = (target.clientInfo?.clientName ?? "").toLowerCase();
        console.error(
          `[MCP] Auto-redirect ${target.agentId.slice(0, 24)} (${clientName} inner client) ` +
            `→ ${bridge.agentId.slice(0, 24)} (bridge) — bridge injects the turn into the CLI.`,
        );
        return bridge;
      }
    } catch {
      // Fall through to original target
    }
    return target;
  }

  private async resolveAgent(agentId: string): Promise<RegistryEntry> {
    const selfIdentity = this.options.identity ?? "global";
    try {
      const entry = await this.registry.getAgent(agentId);
      if (entry.entryType === "client" && (entry.identity ?? "global") !== selfIdentity) {
        throw new Error(`Agent "${agentId}" belongs to a different identity namespace.`);
      }
      if (entry.url) return entry;
      const all = await this.registry.listAgents();
      const withUrl = all.find(
        (a) =>
          a.url &&
          pathsEqual(a.projectPath, entry.projectPath) &&
          (a.entryType !== "client" || (a.identity ?? "global") === selfIdentity),
      );
      if (withUrl) return withUrl;
      return entry;
    } catch {
      const all = await this.registry.listAgents();
      const scoped = all.filter(
        (a) => a.entryType !== "client" || (a.identity ?? "global") === selfIdentity,
      );
      const isMatch = (a: RegistryEntry) =>
        a.name.toLowerCase() === agentId.toLowerCase() ||
        a.agentId.startsWith(agentId) ||
        normalizePathKey(a.projectPath).includes(agentId.trim().replace(/\\/g, "/").toLowerCase());
      const matchWithUrl = scoped.find((a) => a.url && isMatch(a));
      if (matchWithUrl) return matchWithUrl;
      const anyMatch = scoped.find(isMatch);
      if (!anyMatch) throw new Error(`Agent "${agentId}" not found. Use list_agents to see available agents.`);
      return anyMatch;
    }
  }

  private async resolveClientSession(params: {
    clientId?: string;
    project?: string;
    clientType?: string;
    conversationId?: string;
  }): Promise<RegistryEntry> {
    const all = await this.registry.listAgents();
    const selfIdentity = this.options.identity ?? "global";
    const clients = all.filter(
      (entry) =>
        entry.entryType === "client" &&
        (entry.identity ?? "global") === selfIdentity,
    );

    if (params.clientId) {
      const clientId = params.clientId.trim();
      const exact = clients.find((e) => e.agentId === clientId);
      if (exact) return exact;

      const prefixMatches = clients.filter((e) => e.agentId.startsWith(clientId));
      if (prefixMatches.length === 1) return prefixMatches[0]!;
      if (prefixMatches.length > 1) {
        const list = prefixMatches.map((e) => `${e.agentId} (${e.name})`).join(", ");
        throw new Error(`Ambiguous clientId prefix "${params.clientId}" matches multiple sessions: ${list}`);
      }
      throw new Error(`Client session "${params.clientId}" not found in identity "${selfIdentity}". Use list_agents with includeClients=true.`);
    }

    if (!params.project && params.conversationId) {
      const messages = this.channelRuntime.listConversationMessages(params.conversationId);
      const otherMsg = messages.find((m) => m.fromAgentId !== this.clientAgentId);
      if (otherMsg?.fromAgentId) {
        const match = clients.find((c) => c.agentId === otherMsg.fromAgentId);
        if (match) return match;
      }
      const ourMsg = messages.find((m) => m.fromAgentId === this.clientAgentId && m.toAgentId);
      if (ourMsg?.toAgentId) {
        const match = clients.find((c) => c.agentId === ourMsg.toAgentId);
        if (match) return match;
      }
    }

    if (!params.project) {
      throw new Error("Either clientId or project is required. Use list_agents with includeClients=true to see available clients.");
    }

    const normalizedNeedle = params.project.trim().replace(/\\/g, "/").toLowerCase();
    let matches = clients.filter((entry) => pathsEqual(entry.projectPath, params.project));
    if (matches.length === 0) {
      matches = clients.filter(
        (entry) =>
          normalizePathKey(entry.projectPath).includes(normalizedNeedle) ||
          entry.projectName.toLowerCase().includes(normalizedNeedle),
      );
    }

    if (matches.length === 0) {
      throw new Error(
        `No client session found for project "${params.project}". Use list_agents with includeClients=true.`,
      );
    }

    if (params.clientType) {
      const typeFiltered = matches.filter((e) =>
        e.clientInfo?.clientName?.toLowerCase().includes(params.clientType!.toLowerCase()),
      );
      if (typeFiltered.length > 0) matches = typeFiltered;
    }

    if (matches.length > 1) {
      const CLIENT_PRIORITY = ["opencode", "antigravity", "agy", "codex-cli", "codex"];
      const getPriority = (e: RegistryEntry) => {
        const cv = e.clientInfo?.clientVersion ?? "";
        if (cv === "app-server-bridge" || cv === "opencode-plugin-bridge") return -1;
        const name = e.clientInfo?.clientName?.toLowerCase() ?? "";
        const idx = CLIENT_PRIORITY.findIndex((p) => name.includes(p));
        return idx === -1 ? CLIENT_PRIORITY.length : idx;
      };
      matches = [...matches].sort((a, b) => getPriority(a) - getPriority(b));
      const chosen = matches[0]!;
      const allIds = matches
        .map((e) => `${e.agentId.slice(0, 16)} (${e.clientInfo?.clientName ?? "unknown"})`)
        .join(", ");
      console.error(
        `[MCP] Multiple clients match "${params.project}": [${allIds}]. Using: ${chosen.agentId} (${chosen.clientInfo?.clientName}). Use clientId or clientType to be explicit.`,
      );
    }

    return matches[0]!;
  }

  private async handleMessageClientSession(params: {
    clientId?: string;
    project?: string;
    clientType?: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    taskId?: string;
    expectsResponse?: boolean;
    timeoutMs?: number;
    model?: string;
    reasoning?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      const resolved = await this.resolveClientSession({
        clientId: params.clientId,
        project: params.project,
        clientType: params.clientType,
        conversationId: params.conversationId,
      });
      const client = await this.resolveDeliverableTarget(resolved);
      const expectsResponse = params.expectsResponse ?? inferExpectsResponse(params.message);
      const expiresAt = expectsResponse ? Date.now() + (params.timeoutMs ?? 300_000) : undefined;
      const fromAgentId = this.clientAgentId ?? "mcp-adapter";
      const deterministicConversationId = this.buildDeterministicConversationId(fromAgentId, client.agentId);
      const resolvedConversationId = params.conversationId ?? deterministicConversationId;

      const snapshot =
        params.replyTo || params.conversationId
          ? (
              await this.conversationService.replyAndAcknowledge({
                agentId: client.agentId,
                conversationId: resolvedConversationId,
                replyTo: params.replyTo,
                taskId: params.taskId,
                message: params.message,
                kind: "chat",
                requiresAck: true,
                expectsResponse,
                expiresAt,
                meta: {
                  targetClientId: client.agentId,
                  targetProject: client.projectPath,
                  targetClientName: client.clientInfo?.clientName,
                  ...(params.model ? { model: params.model } : {}),
                  ...(params.reasoning ? { reasoning: params.reasoning } : {}),
                },
              })
            ).snapshot
          : await this.conversationService.startConversation({
              toAgentId: client.agentId,
              taskId: params.taskId,
              message: params.message,
              kind: "chat",
              expectsResponse,
              requiresAck: true,
              expiresAt,
              conversationId: resolvedConversationId,
              meta: {
                targetClientId: client.agentId,
                targetProject: client.projectPath,
                targetClientName: client.clientInfo?.clientName,
                ...(params.model ? { model: params.model } : {}),
                ...(params.reasoning ? { reasoning: params.reasoning } : {}),
              },
            });
      const channelMessage = snapshot.messages[snapshot.messages.length - 1];

      const isPushClient =
        this.clientProfile.id === "opencode" ||
        (this.clientProfile.id === "codex" && codexDaemonSocketPath() !== null) ||
        (this.clientProfile.id === "antigravity" &&
          readAgyConversation(process.ppid, process.env, this.resolvedProjectPath) !== undefined);

      const deliveryAck = await this.conversationService.waitForAcknowledgement(
        channelMessage.conversationId,
        channelMessage.messageId,
        { timeoutMs: 3_000, states: ["delivered_to_bridge", "displayed_to_client", "answered", "failed"] },
      );

      let deliveryState = deliveryAck;
      if (
        !isPushClient &&
        expectsResponse &&
        deliveryAck &&
        deliveryAck !== "answered" &&
        deliveryAck !== "failed"
      ) {
        const replyAck = await this.conversationService.waitForAcknowledgement(
          channelMessage.conversationId,
          channelMessage.messageId,
          {
            timeoutMs: Math.max(1_000, params.timeoutMs ?? 300_000),
            states: ["answered", "failed"],
          },
        );
        if (replyAck) deliveryState = replyAck;
      }

      let replyPreview = "";
      if (deliveryState === "answered") {
        const msgs = this.channelRuntime.listConversationMessages(channelMessage.conversationId);
        const reply = msgs.find((m) => m.replyTo === channelMessage.messageId);
        if (reply) replyPreview = `\n  reply:          ${reply.content.slice(0, 500)}`;
      }

      const statusNote =
        deliveryState === "answered"
          ? ""
          : deliveryState === "failed"
            ? "\n  Note: Delivery failed — the target bridge rejected the message."
            : isPushClient && deliveryState
              ? "\n  Note: Message delivered. The reply will arrive in this session as a new message.\n  To check now: call channel_inbox(pendingOnly=true)"
              : deliveryState
                ? "\n  Note: Message delivered but no reply within timeout.\n  Call channel_inbox(pendingOnly=true) to check for the reply."
                : "\n  Note: No delivery confirmation yet. The target bridge may be offline.\n  To check: call channel_inbox(pendingOnly=true)";

      return {
        content: [
          {
            type: "text" as const,
            text:
              [
                `Channel message sent to ${client.name}`,
                `  toAgentId:      ${client.agentId}`,
                `  conversationId: ${channelMessage.conversationId}`,
                `  messageId:      ${channelMessage.messageId}`,
                `  deliveryState:  ${deliveryState ?? "pending"}`,
              ].join("\n") +
              replyPreview +
              statusNote,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  private async startHttpTransport(port: number): Promise<void> {
    const { default: express } = await import("express");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

    this.setupClientDetection();

    const app = express();
    app.use(localCorsMiddleware("GET, POST, OPTIONS"));

    const transports = new Map<string, InstanceType<typeof SSEServerTransport>>();

    app.get("/mcp", async (_req, res) => {
      const transport = new SSEServerTransport("/mcp/message", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => {
        transports.delete(transport.sessionId);
      });
      await this.server.connect(transport);
    });

    app.post("/mcp/message", async (req, res) => {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.status(400).json({ error: "No matching active SSE session" });
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    app.get("/", (_req, res) => {
      res.json({
        server: "agent-communication-bridge MCP",
        endpoints: { sse: "/mcp", message: "/mcp/message" },
      });
    });

    await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));
    console.error(`[MCP] HTTP server at http://localhost:${port}/mcp`);
  }
}
