import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClientId } from "../cli/commands/antigravity.js";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import { ChannelTransport } from "../client/channel-transport.js";
import { RegistryClient } from "../client/registry-client.js";
import { McpAgentBridge, buildStableClientAgentId } from "../mcp/adapter.js";
import { findPairedBridgeAgent } from "../mcp/peer-classifier.js";
import { RegistryServer } from "../registry/server.js";
import { AgentStore } from "../registry/store.js";
import type { AgentRegistration, RegistryEntry } from "../types/messages.js";

function makeClientReg(
  agentId: string,
  overrides: Partial<AgentRegistration> = {},
): AgentRegistration {
  return {
    agentId,
    name: "proj",
    url: "",
    wsUrl: "",
    port: 0,
    projectPath: "/tmp/proj",
    projectName: "proj",
    projectType: "node",
    card: {
      name: "proj",
      description: "",
      url: "",
      version: "1.0.0",
      protocolVersion: "0.3.0",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    registeredAt: Date.now(),
    entryType: "client",
    identity: "global",
    clientInfo: { clientName: "antigravity-client", clientVersion: "1.0.0" },
    ...overrides,
  };
}

describe("buildStableClientAgentId — canonical path & per-session isolation", () => {
  it("normalizes path separators and trailing slashes into the same base project hash", () => {
    const a = buildStableClientAgentId("antigravity-client", "/work/my-app/");
    const b = buildStableClientAgentId("antigravity-client", "/work/my-app");
    expect(a).toBe(b);

    if (process.platform === "win32") {
      const winLower = buildStableClientAgentId("antigravity-client", "c:\\Users\\Dev\\My App\\");
      const winUpper = buildStableClientAgentId("antigravity-client", "C:/Users/Dev/My App");
      expect(winLower).toBe(winUpper);
    }
  });

  it("derives distinct IDs for different sessionKeys while keeping the project prefix", () => {
    const base = buildStableClientAgentId("antigravity-client", "/work/my-app", "global");
    const sess1 = buildStableClientAgentId("antigravity-client", "/work/my-app", "global", "session-1");
    const sess2 = buildStableClientAgentId("antigravity-client", "/work/my-app", "global", "session-2");

    expect(sess1).not.toBe(sess2);
    expect(sess1.startsWith(`${base}-`)).toBe(true);
    expect(sess2.startsWith(`${base}-`)).toBe(true);
    expect(sess1).toMatch(/^client-antigravity-client-[0-9a-f]{12}-[0-9a-f]{6}$/);
  });
});

describe("AgentStore — concurrent sessions, upgrades, and orphan cleanup", () => {
  it("allows two live sessions with different sessionIds in the same project to coexist", () => {
    const store = new AgentStore();
    store.register(makeClientReg("client-antigravity-client-aaaa1111bbbb-111111", { sessionId: "s1", pid: process.pid, host: hostname() }));
    store.register(makeClientReg("client-antigravity-client-aaaa1111bbbb-222222", { sessionId: "s2", pid: process.pid, host: hostname() }));

    expect(store.count()).toBe(2);
    expect(store.get("client-antigravity-client-aaaa1111bbbb-111111")).toBeDefined();
    expect(store.get("client-antigravity-client-aaaa1111bbbb-222222")).toBeDefined();
  });

  it("evicts an entry sharing the same sessionId (e.g. placeholder -> initialized)", () => {
    const store = new AgentStore();
    store.register(
      makeClientReg("client-mcp-client-000000000000-111111", {
        sessionId: "s1",
        projectPath: "/plugin/oab",
        clientInfo: { clientName: "mcp-client", clientVersion: "1.0.0" },
      }),
    );
    store.register(
      makeClientReg("client-antigravity-client-111111111111-111111", {
        sessionId: "s1",
        projectPath: "/proj/real",
        clientInfo: { clientName: "antigravity-client", clientVersion: "1.0.0" },
      }),
    );

    expect(store.count()).toBe(1);
    expect(store.get("client-mcp-client-000000000000-111111")).toBeUndefined();
    expect(store.get("client-antigravity-client-111111111111-111111")).toBeDefined();
  });

  it("reaps a dead local PID orphan when a new session registers in the same project", () => {
    const store = new AgentStore();
    store.register(makeClientReg("client-old", { sessionId: "s-dead", pid: 2_147_483_646, host: hostname() }));
    store.register(makeClientReg("client-live", { sessionId: "s-live", pid: process.pid, host: hostname() }));

    expect(store.get("client-old")).toBeUndefined();
    expect(store.get("client-live")).toBeDefined();
  });

  it("matches project queries with forward/backslash and Windows case normalization", () => {
    const store = new AgentStore();
    const projectPath = process.platform === "win32" ? "c:\\Users\\Dev\\Repo One" : "/tmp/RepoOne";
    store.register(makeClientReg("c1", { projectPath, sessionId: "s1" }));

    const needle = process.platform === "win32" ? "C:/Users/Dev/Repo One/" : "/tmp/RepoOne/";
    expect(store.findByProject(needle)?.agentId).toBe("c1");
    expect(store.list({ project: needle })).toHaveLength(1);
  });
});

describe("findPairedBridgeAgent — same-project multi-Codex bridge isolation", () => {
  it("pairs each inner Codex client strictly with its ancestor bridge daemon", () => {
    const bridge1: RegistryEntry = {
      ...makeClientReg("client-codex-bridge-aaaa-111111", {
        pid: 5001,
        clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    const bridge2: RegistryEntry = {
      ...makeClientReg("client-codex-bridge-aaaa-222222", {
        pid: 6001,
        clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    const inner1: RegistryEntry = {
      ...makeClientReg("client-codex-mcp-client-aaaa-111111", {
        ancestorPids: [5003, 5002, 5001],
        clientInfo: { clientName: "codex-mcp-client", clientVersion: "1.0.0" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    const inner2: RegistryEntry = {
      ...makeClientReg("client-codex-mcp-client-aaaa-222222", {
        ancestorPids: [6003, 6002, 6001],
        clientInfo: { clientName: "codex-mcp-client", clientVersion: "1.0.0" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };

    const all = [bridge1, bridge2, inner1, inner2];
    expect(findPairedBridgeAgent(inner1, all)?.agentId).toBe(bridge1.agentId);
    expect(findPairedBridgeAgent(inner2, all)?.agentId).toBe(bridge2.agentId);
  });

  it("keeps decoupled single-bridge fallback and returns undefined when multiple unlinked bridges exist", () => {
    const bridge1: RegistryEntry = {
      ...makeClientReg("client-codex-bridge-aaaa-111111", {
        pid: 5001,
        clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    const bridge2: RegistryEntry = {
      ...makeClientReg("client-codex-bridge-aaaa-222222", {
        pid: 6001,
        clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    const standaloneInner: RegistryEntry = {
      ...makeClientReg("client-codex-mcp-client-aaaa-999999", {
        ancestorPids: [9001],
        clientInfo: { clientName: "codex-mcp-client", clientVersion: "1.0.0" },
      }),
      lastHeartbeat: Date.now(),
      healthy: true,
    };

    expect(findPairedBridgeAgent(standaloneInner, [bridge1, standaloneInner])?.agentId).toBe(bridge1.agentId);
    expect(findPairedBridgeAgent(standaloneInner, [bridge1, bridge2, standaloneInner])).toBeUndefined();
  });
});

describe("Registry + McpAgentBridge — end-to-end multi-project & same-project session isolation", () => {
  let tmpRoot: string;
  let registry: RegistryServer;
  let registryUrl: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acb-iso-e2e-"));
    registry = new RegistryServer(0, join(tmpRoot, "registry.sqlite"));
    await registry.start();
    registryUrl = `http://localhost:${registry.getPort()}`;
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
    await registry.stop();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("keeps two live same-project WS sessions open without 4001 superseding and delivers messages exclusively to the addressed session", async () => {
    const rt1 = new ChannelClientRuntime({ transport: new ChannelTransport({ registryUrl }) });
    const rt2 = new ChannelClientRuntime({ transport: new ChannelTransport({ registryUrl }) });
    cleanups.push(() => rt1.destroyRuntime(), () => rt2.destroyRuntime());

    const ws1Closed: number[] = [];
    const ws2Closed: number[] = [];
    const rt1Inbox: string[] = [];
    const rt2Inbox: string[] = [];

    rt1.on("channel.message", (m) => {
      if (m.toAgentId === "sess-1") rt1Inbox.push(m.content);
    });
    rt2.on("channel.message", (m) => {
      if (m.toAgentId === "sess-2") rt2Inbox.push(m.content);
    });

    await rt1.activateClient(makeClientReg("sess-1", { sessionId: "uuid-1", projectPath: tmpRoot }));
    rt1.getWebSocket()?.on("close", (code) => ws1Closed.push(code));

    await rt2.activateClient(makeClientReg("sess-2", { sessionId: "uuid-2", projectPath: tmpRoot }));
    rt2.getWebSocket()?.on("close", (code) => ws2Closed.push(code));

    await rt1.sendMessage({ toAgentId: "sess-2", content: "for-session-two" });
    await rt2.sendMessage({ toAgentId: "sess-1", content: "for-session-one" });

    await new Promise((r) => setTimeout(r, 150));

    expect(ws1Closed).toEqual([]);
    expect(ws2Closed).toEqual([]);
    expect(rt1Inbox).toEqual(["for-session-one"]);
    expect(rt2Inbox).toEqual(["for-session-two"]);

    const client = new RegistryClient(registryUrl);
    const listed = await client.listAgents({ entryType: "client" });
    expect(listed.map((a) => a.agentId).sort()).toEqual(["sess-1", "sess-2"]);
  }, 15_000);

  it("resolves distinct projects automatically for global-plugin Antigravity MCP servers (roots: false) and isolates sessions end-to-end", async () => {
    const fakePluginDir = join(tmpRoot, ".gemini", "config", "plugins", "oab");
    const projA = join(tmpRoot, "project-alpha");
    const projB = join(tmpRoot, "project-beta");
    mkdirSync(fakePluginDir, { recursive: true });
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const bridgeA1 = new McpAgentBridge({
      registryUrl,
      auto: false,
      projectPath: fakePluginDir,
      projectPathExplicit: false,
      sessionId: "agy-session-a1",
      ancestorEntries: [{ pid: 7001, ppid: 1, name: "agy.exe", commandLine: `agy.exe "--add-dir=${projA}"` }],
    });
    const bridgeA2 = new McpAgentBridge({
      registryUrl,
      auto: false,
      projectPath: fakePluginDir,
      projectPathExplicit: false,
      sessionId: "agy-session-a2",
      ancestorEntries: [{ pid: 7002, ppid: 1, name: "agy.exe", commandLine: `agy.exe "--add-dir=${projA}"` }],
    });
    const bridgeB = new McpAgentBridge({
      registryUrl,
      auto: false,
      projectPath: fakePluginDir,
      projectPathExplicit: false,
      sessionId: "agy-session-b",
      ancestorEntries: [{ pid: 8001, ppid: 1, name: "agy.exe", commandLine: `agy.exe "--add-dir=${projB}"` }],
    });

    const connectAntigravityClient = async (bridge: McpAgentBridge) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "antigravity-client", version: "1.0.0" },
        { capabilities: {} }, // roots: false (just like Antigravity)
      );
      await bridge.startWithTransport(serverTransport);
      await mcpClient.connect(clientTransport);
      cleanups.push(async () => {
        await mcpClient.close();
        await bridge.stop();
      });
      await new Promise((r) => setTimeout(r, 80));
      return mcpClient;
    };

    const clientA1 = await connectAntigravityClient(bridgeA1);
    const clientA2 = await connectAntigravityClient(bridgeA2);
    const clientB = await connectAntigravityClient(bridgeB);

    const registryClient = new RegistryClient(registryUrl);
    const registered = await registryClient.listAgents({ entryType: "client" });
    expect(registered).toHaveLength(3);

    const a1Entry = registered.find((e) => e.sessionId === "agy-session-a1");
    const a2Entry = registered.find((e) => e.sessionId === "agy-session-a2");
    const bEntry = registered.find((e) => e.sessionId === "agy-session-b");

    expect(a1Entry?.projectPath).toBe(projA);
    expect(a2Entry?.projectPath).toBe(projA);
    expect(bEntry?.projectPath).toBe(projB);
    expect(new Set([a1Entry?.agentId, a2Entry?.agentId, bEntry?.agentId]).size).toBe(3);

    // Hook client resolution disambiguates two Antigravity sessions in projA by agyPid!
    expect(await resolveClientId(registryClient, projA, undefined, "global", 7001)).toBe(a1Entry?.agentId);
    expect(await resolveClientId(registryClient, projA, undefined, "global", 7002)).toBe(a2Entry?.agentId);
    expect(await resolveClientId(registryClient, projB, undefined, "global", 8001)).toBe(bEntry?.agentId);

    if (!bEntry) throw new Error("Expected project B entry to be registered");

    // Sending from A1 to B reaches ONLY B's inbox, never A2's!
    // Use expectsResponse: false so deterministic push/polling doesn't depend on host agy-<pid>.json files.
    await clientA1.callTool({
      name: "message_client_session",
      arguments: { clientId: bEntry.agentId, message: "hello project B", expectsResponse: false },
    });

    await new Promise((r) => setTimeout(r, 80));

    const bInbox = await clientB.callTool({ name: "channel_inbox", arguments: { pendingOnly: false } });
    const a2Inbox = await clientA2.callTool({ name: "channel_inbox", arguments: { pendingOnly: false } });
    const bText = JSON.stringify(bInbox);
    const a2Text = JSON.stringify(a2Inbox);

    expect(bText).toContain("hello project B");
    expect(a2Text).not.toContain("hello project B");
  }, 15_000);
});
