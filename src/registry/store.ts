// In-memory agent store for the registry
import { hostname } from "node:os";
import type { AgentRegistration, AgentListFilter, RegistryEntry } from "../types/messages.js";
import type { RegistryEventBus } from "./events.js";
import { normalizePathKey, pathsEqual } from "../utils/path.js";
import { isPidAlive } from "../utils/process.js";

const UNHEALTHY_THRESHOLD_MS = 90_000;   // 90 seconds
const REMOVE_THRESHOLD_MS = 120_000;      // 2 minutes

/**
 * Determine whether `existing` should be evicted when `incoming` registers or identifies.
 * Allows multiple concurrent live client sessions in the same project/identity to coexist
 * while still cleaning up same-session upgrades (`placeholder -> initialized`) and dead orphans.
 */
export function shouldReplaceRegistryEntry(
  existing: RegistryEntry,
  incoming: AgentRegistration,
  options: { existingHasLiveWs?: boolean } = {},
): boolean {
  if (existing.agentId === incoming.agentId) return false;

  const incomingType = incoming.entryType ?? "agent";
  const existingType = existing.entryType ?? "agent";

  if (incomingType === "agent" && existingType === "agent") {
    return pathsEqual(existing.projectPath, incoming.projectPath);
  }

  if (incomingType !== "client" || existingType !== "client") {
    return false;
  }

  // Same live runtime instance upgrading its ID (e.g. placeholder -> initialized or
  // plugin fallback cwd -> real workspace path) replaces its own prior entry.
  if (incoming.sessionId && existing.sessionId && incoming.sessionId === existing.sessionId) {
    return true;
  }

  const sameLogicalClient =
    pathsEqual(existing.projectPath, incoming.projectPath) &&
    existing.clientInfo?.clientName === incoming.clientInfo?.clientName &&
    (existing.identity ?? "global") === (incoming.identity ?? "global");

  if (!sameLogicalClient) {
    return false;
  }

  // Reap provably dead local processes left behind by a crash.
  const localHost = incoming.host ?? hostname();
  if (typeof existing.pid === "number" && existing.host === localHost && !isPidAlive(existing.pid)) {
    return true;
  }

  if (options.existingHasLiveWs) {
    return false;
  }

  // Concurrent sessions with distinct sessionIds must never evict one another.
  if (existing.sessionId || incoming.sessionId) {
    return false;
  }

  // Legacy entries without sessionIds still coexist when owned by distinct live local PIDs.
  if (
    typeof existing.pid === "number" &&
    typeof incoming.pid === "number" &&
    existing.pid !== incoming.pid &&
    (existing.host !== localHost || isPidAlive(existing.pid))
  ) {
    return false;
  }

  return true;
}

export class AgentStore {
  private agents = new Map<string, RegistryEntry>();

  constructor(private readonly eventBus?: RegistryEventBus) {}

  register(registration: AgentRegistration): RegistryEntry {
    // Replace only entries belonging to the same session, dead local orphans, or
    // legacy pid-less reconnects — distinct live sessions in the same project coexist.
    // Collect IDs first, then delete — avoids mutating the map during iteration.
    const toRemove: string[] = [];
    for (const [existingId, existing] of this.agents.entries()) {
      if (shouldReplaceRegistryEntry(existing, registration)) {
        toRemove.push(existingId);
      }
    }
    for (const id of toRemove) {
      this.agents.delete(id);
      this.eventBus?.broadcast({
        type: "agent.deregistered",
        timestamp: new Date().toISOString(),
        data: { agentId: id },
      });
    }

    const entry: RegistryEntry = {
      ...registration,
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    this.agents.set(registration.agentId, entry);
    this.eventBus?.broadcast({
      type: "agent.registered",
      timestamp: new Date().toISOString(),
      data: entry,
    });
    return entry;
  }

  deregister(agentId: string): boolean {
    const removed = this.agents.delete(agentId);
    if (removed) {
      this.eventBus?.broadcast({
        type: "agent.deregistered",
        timestamp: new Date().toISOString(),
        data: { agentId },
      });
    }
    return removed;
  }

  heartbeat(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    const timestamp = new Date().toISOString();
    this.agents.set(agentId, { ...entry, lastHeartbeat: Date.now(), healthy: true });
    this.eventBus?.broadcast({
      type: "agent.heartbeat",
      timestamp,
      data: { agentId, timestamp },
    });
    return true;
  }

  get(agentId: string): RegistryEntry | undefined {
    return this.agents.get(agentId);
  }

  list(filter?: AgentListFilter): RegistryEntry[] {
    let entries = Array.from(this.agents.values());

    if (filter?.healthy !== undefined) {
      entries = entries.filter((e) => e.healthy === filter.healthy);
    }
    if (filter?.skill) {
      const tag = filter.skill;
      entries = entries.filter((e) =>
        e.card.skills.some((s) => s.tags.includes(tag) || s.id === tag)
      );
    }
    if (filter?.project) {
      const project = filter.project.toLowerCase();
      const normalizedNeedle = normalizePathKey(filter.project);
      entries = entries.filter(
        (e) =>
          e.projectPath.toLowerCase().includes(project) ||
          normalizePathKey(e.projectPath).includes(normalizedNeedle) ||
          e.projectName.toLowerCase().includes(project)
      );
    }
    if (filter?.entryType) {
      entries = entries.filter((e) => e.entryType === filter.entryType);
    }

    return entries;
  }

  findBySkill(tag: string): RegistryEntry[] {
    return this.list({ skill: tag });
  }

  findByProject(projectPath: string): RegistryEntry | undefined {
    return this.agents.get(
      [...this.agents.values()].find((e) => pathsEqual(e.projectPath, projectPath))?.agentId ?? ""
    );
  }

  healthCheck(): void {
    const now = Date.now();
    for (const [id, entry] of this.agents) {
      const age = now - entry.lastHeartbeat;
      if (age > REMOVE_THRESHOLD_MS) {
        this.agents.delete(id);
        this.eventBus?.broadcast({
          type: "agent.removed",
          timestamp: new Date().toISOString(),
          data: { agentId: id },
        });
      } else if (age > UNHEALTHY_THRESHOLD_MS && entry.healthy) {
        this.agents.set(id, { ...entry, healthy: false });
        this.eventBus?.broadcast({
          type: "agent.unhealthy",
          timestamp: new Date().toISOString(),
          data: { agentId: id },
        });
      }
    }
  }

  markUnhealthy(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.healthy) return;
    this.agents.set(agentId, { ...entry, healthy: false });
    this.eventBus?.broadcast({
      type: "agent.unhealthy",
      timestamp: new Date().toISOString(),
      data: { agentId },
    });
  }

  count(): number {
    return this.agents.size;
  }
}
