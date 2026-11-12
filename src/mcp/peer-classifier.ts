import { createHash } from "node:crypto";
import type { RegistryEntry } from "../types/messages.js";
import { normalizePathKey, pathsEqual } from "../utils/path.js";

export type PeerType =
  | "codex-bridge"
  | "codex-inner"
  | "antigravity-inner"
  | "opencode-code"
  | "opencode-bridge"
  | "unknown";

/**
 * Compute a client `agentId` from `(clientName, normalizedProjectPath, identity)`.
 * When `sessionKey` is omitted, returns the deterministic 12-char project hash.
 * When `sessionKey` is provided, appends a 6-char per-session suffix so multiple
 * live sessions in the same project/namespace get distinct IDs without colliding.
 */
export function buildStableClientAgentId(
  clientName: string,
  projectPath: string,
  identity = "global",
  sessionKey?: string,
): string {
  const canonicalPath = normalizePathKey(projectPath);
  const digest = createHash("sha1")
    .update(`${clientName}\n${canonicalPath}\n${identity}`)
    .digest("hex")
    .slice(0, 12);
  if (!sessionKey) {
    return `client-${clientName}-${digest}`;
  }
  const sessionTag = createHash("sha1").update(sessionKey).digest("hex").slice(0, 6);
  return `client-${clientName}-${digest}-${sessionTag}`;
}

/** Bridge daemon versions that pair 1:1 with inner Codex or OpenCode clients. */
export function isBridgeDaemonEntry(entry: RegistryEntry): boolean {
  const cv = entry.clientInfo?.clientVersion ?? "";
  return cv === "app-server-bridge" || cv === "acp-bridge" || cv === "opencode-plugin-bridge";
}

/**
 * Find the paired bridge daemon for an inner Codex/OpenCode client entry.
 * Prefers an exact process-ancestry match (`target.ancestorPids.includes(bridge.pid)`)
 * or shared `sessionId` so concurrent sessions in the same project never hijack each
 * other's bridge, falling back to a single unambiguous same-project bridge when decoupled.
 */
export function findPairedBridgeAgent(
  target: RegistryEntry,
  candidates: readonly RegistryEntry[],
): RegistryEntry | undefined {
  if (isBridgeDaemonEntry(target)) return undefined;
  const cn = (target.clientInfo?.clientName ?? "").toLowerCase();
  const wantsCodex = cn.includes("codex");
  const wantsOpenCode = cn.includes("opencode");
  if (!wantsCodex && !wantsOpenCode) return undefined;

  const targetIdentity = target.identity ?? "global";
  const sameProjectBridges = candidates.filter((candidate) => {
    if (candidate.entryType !== "client" || !isBridgeDaemonEntry(candidate)) return false;
    if ((candidate.identity ?? "global") !== targetIdentity) return false;
    if (!pathsEqual(candidate.projectPath, target.projectPath)) return false;
    const cv = candidate.clientInfo?.clientVersion ?? "";
    if (wantsOpenCode) return cv === "opencode-plugin-bridge";
    return cv === "app-server-bridge" || cv === "acp-bridge";
  });

  if (sameProjectBridges.length === 0) return undefined;

  const bySessionOrAncestry = sameProjectBridges.filter(
    (bridge) =>
      (target.sessionId && bridge.sessionId && target.sessionId === bridge.sessionId) ||
      (typeof bridge.pid === "number" &&
        Array.isArray(target.ancestorPids) &&
        target.ancestorPids.includes(bridge.pid)),
  );
  if (bySessionOrAncestry.length > 0) {
    return bySessionOrAncestry.find((b) => b.healthy) ?? bySessionOrAncestry[0];
  }

  if (sameProjectBridges.length === 1) {
    return sameProjectBridges[0];
  }

  return undefined;
}

/**
 * Classify a registry entry into one of the canonical Triad peer types
 * (`Antigravity`, `Codex`, `OpenCode`, or internal bridge entries).
 */
export function getPeerType(entry: RegistryEntry): PeerType {
  const clientName = (entry.clientInfo?.clientName ?? "").toLowerCase();
  const clientVersion = entry.clientInfo?.clientVersion ?? "";

  if (clientVersion === "opencode-plugin-bridge" || (clientName.includes("opencode") && clientVersion === "bridge")) {
    return "opencode-bridge";
  }
  if (clientName === "opencode" || clientName.includes("opencode")) return "opencode-code";
  if (clientVersion === "app-server-bridge") return "codex-bridge";
  if (clientName.includes("codex")) return "codex-inner";
  if (clientName.includes("antigravity") || clientName === "agy") return "antigravity-inner";
  return "unknown";
}

/**
 * Render the display label for a classified peer entry in `list_agents` and `channel_inbox`.
 */
export function getPeerTypeLabel(entry: RegistryEntry): string {
  switch (getPeerType(entry)) {
    case "opencode-code":
      return "OpenCode";
    case "opencode-bridge":
      return "OpenCode bridge";
    case "codex-bridge":
      return "Codex bridge";
    case "codex-inner":
      return "Codex inner";
    case "antigravity-inner":
      return "Antigravity inner";
    default:
      return entry.clientInfo?.clientName ?? "unknown";
  }
}

const NO_RESPONSE_PATTERNS = [
  /\bno (?:hace falta|necesito|requiero|requiere|respondas|responder|respuesta)\b/,
  /\b(?:sin|no) respuesta\b/,
  /\bno reply\b/,
  /\bno response (?:needed|required)\b/,
  /\bfyi\b/,
  /\bf\.?y\.?i\.?\b/,
  /\bsolo inform(?:o|ativo|acion)\b/,
  /\bjust (?:fyi|info|letting you know)\b/,
  /\bfor your (?:information|info)\b/,
  /\binformational only\b/,
  /\b(?:no need|don'?t need)\s+to (?:reply|respond|answer)\b/,
];

/**
 * Infer whether an outbound message requires a reply when `expectsResponse` is omitted.
 * Defaults to `true` unless the text explicitly indicates an informational/FYI broadcast.
 */
export function inferExpectsResponse(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return !NO_RESPONSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Render a human-readable summary of connected skilled agents and Triad client sessions.
 */
export function formatAgentsSummary(agents: RegistryEntry[]): string {
  if (agents.length === 0) {
    return "No agents currently connected. Start one with: agent-communication-bridge start <project-path>";
  }

  const runnableAgents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
  const clients = agents.filter((a) => {
    if (a.entryType !== "client" || a.card.skills.length !== 0) return false;
    const peerType = getPeerType(a);
    return peerType !== "codex-bridge" && peerType !== "opencode-bridge";
  });

  return [
    `${agents.length} entry(ies) connected via agent-communication-bridge:\n`,
    runnableAgents.length > 0 ? "Agents with skills:\n" : "Agents with skills:\n  (none)",
    ...runnableAgents.map((a) => {
      const skills = a.card.skills.map((s) => `    • ${s.id}: ${s.description}`).join("\n");
      return [
        `Agent: ${a.name}  [${a.agentId.slice(-8)}]`,
        `  Project: ${a.projectPath}`,
        `  Type:    ${a.projectType}${a.entryType === "client" ? " (client — no skills)" : ""}`,
        `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
        `  Skills:\n${skills}`,
      ].join("\n");
    }),
    "",
    clients.length > 0 ? "Client sessions via channels:\n" : "Client sessions via channels:\n  (none)",
    ...clients.map((a) =>
      [
        `[${getPeerTypeLabel(a)}]  ${a.name}  [${a.agentId.slice(-8)}]`,
        `  agentId: ${a.agentId}`,
        `  Project: ${a.projectPath}`,
        `  Client:  ${a.clientInfo?.clientName ?? "unknown"} v${a.clientInfo?.clientVersion ?? "unknown"}`,
        `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
        `  Use:     message_client_session (routing to the bridge is automatic)`,
      ].join("\n"),
    ),
  ].join("\n");
}
