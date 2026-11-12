import { describe, expect, it } from "vitest";
import { getPeerType, getPeerTypeLabel, inferExpectsResponse } from "../mcp/adapter.js";
import type { RegistryEntry } from "../types/messages.js";

/**
 * Pure-function tests for the peer-type taxonomy used in `list_agents` and
 * `channel_inbox` output for the Triad (Antigravity, Codex, OpenCode).
 */

function entry(overrides: Partial<RegistryEntry> & { agentId?: string }): RegistryEntry {
  return {
    agentId: overrides.agentId ?? "client-stub-0001",
    name: "stub",
    url: "",
    wsUrl: "",
    port: 0,
    projectPath: "/tmp",
    projectName: "stub",
    projectType: "unknown",
    card: {
      name: "stub",
      description: "",
      url: "",
      version: "0",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    registeredAt: 0,
    entryType: "client",
    ...overrides,
  } as RegistryEntry;
}

describe("getPeerType", () => {
  it("classifies OpenCode by clientName 'opencode'", () => {
    expect(getPeerType(entry({ clientInfo: { clientName: "opencode", clientVersion: "1.2" } }))).toBe(
      "opencode-code",
    );
  });

  it("classifies OpenCode bridge by clientVersion 'bridge'", () => {
    expect(getPeerType(entry({ clientInfo: { clientName: "opencode", clientVersion: "bridge" } }))).toBe(
      "opencode-bridge",
    );
  });

  it("classifies Codex bridge by clientVersion 'app-server-bridge'", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" } })),
    ).toBe("codex-bridge");
  });

  it("classifies Codex inner by clientName containing 'codex' without bridge clientVersion", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "codex-cli", clientVersion: "0.128.0" } })),
    ).toBe("codex-inner");
  });

  it("classifies Antigravity inner by clientName containing 'antigravity'", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "antigravity", clientVersion: "1.0" } })),
    ).toBe("antigravity-inner");
  });

  it("classifies Antigravity inner by the 'agy' binary clientName", () => {
    expect(getPeerType(entry({ clientInfo: { clientName: "agy", clientVersion: "1.0" } }))).toBe(
      "antigravity-inner",
    );
  });

  it("falls back to 'unknown' for unrecognized clients", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "vscode-llm", clientVersion: "1.0" } })),
    ).toBe("unknown");
  });

  it("treats missing clientInfo as 'unknown'", () => {
    expect(getPeerType(entry({ clientInfo: undefined } as unknown as Partial<RegistryEntry>))).toBe(
      "unknown",
    );
  });
});

describe("getPeerTypeLabel", () => {
  it("maps each peerType to its human label", () => {
    const cases: Array<[Partial<RegistryEntry>, string]> = [
      [{ clientInfo: { clientName: "opencode", clientVersion: "1.0" } }, "OpenCode"],
      [{ clientInfo: { clientName: "opencode", clientVersion: "bridge" } }, "OpenCode bridge"],
      [{ clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" } }, "Codex bridge"],
      [{ clientInfo: { clientName: "codex-cli", clientVersion: "0.1" } }, "Codex inner"],
      [{ clientInfo: { clientName: "antigravity", clientVersion: "1.0" } }, "Antigravity inner"],
      [{ clientInfo: { clientName: "agy", clientVersion: "1.0" } }, "Antigravity inner"],
    ];
    for (const [overrides, label] of cases) {
      expect(getPeerTypeLabel(entry(overrides))).toBe(label);
    }
  });

  it("falls back to clientName for unknown peers, not the literal 'unknown'", () => {
    expect(
      getPeerTypeLabel(entry({ clientInfo: { clientName: "vscode-llm", clientVersion: "1.0" } })),
    ).toBe("vscode-llm");
  });
});

describe("inferExpectsResponse", () => {
  it("returns true for explicit questions and ack requests", () => {
    expect(inferExpectsResponse("¿Estás recibiendo mis mensajes? Un simple ack alcanza.")).toBe(true);
    expect(inferExpectsResponse("Necesito tu confirmación o último blocker.")).toBe(true);
    expect(inferExpectsResponse("Revisa este diff y valida si hay hallazgo crítico.")).toBe(true);
  });

  it("returns true by default for conversational/ambiguous messages", () => {
    expect(inferExpectsResponse("hola mundo")).toBe(true);
    expect(inferExpectsResponse("Actualicé la documentación del módulo.")).toBe(true);
    expect(inferExpectsResponse("El build está listo.")).toBe(true);
    expect(inferExpectsResponse("Ping.")).toBe(true);
  });

  it("returns false ONLY when the sender explicitly opts into fire-and-forget", () => {
    expect(inferExpectsResponse("FYI: el build quedó verde, no response needed.")).toBe(false);
    expect(inferExpectsResponse("Solo informo que el deploy terminó. Sin respuesta.")).toBe(false);
    expect(inferExpectsResponse("Actualicé la documentación del módulo. FYI nomás.")).toBe(false);
    expect(inferExpectsResponse("Just letting you know the migration is done.")).toBe(false);
    expect(inferExpectsResponse("For your information: deploy completed.")).toBe(false);
    expect(inferExpectsResponse("No need to reply — heads up that the linter passed.")).toBe(false);
  });
});
