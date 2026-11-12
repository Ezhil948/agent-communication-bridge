import type { AgentMessage, ChannelMessage } from "../types/messages.js";
import { AntigravityClientProfile } from "./profiles/antigravity-client-profile.js";
import { CodexClientProfile } from "./profiles/codex-client-profile.js";
import { OpenCodeClientProfile } from "./profiles/opencode-client-profile.js";

export interface ClientNotificationEnvelope {
  method: string;
  params: Record<string, unknown>;
}

export interface LegacyNotifyPayload {
  agentId?: string;
  agentName?: string;
  content: string;
  meta?: Record<string, unknown>;
  conversationId?: string;
  messageId?: string;
}

export interface AcceptsChannelMessageContext {
  /**
   * Bridge daemon agentIds sharing the same project path as the inner MCP client.
   * When auto-redirect rewrites `toAgentId` to a sibling bridge, the inner client
   * still accepts the message locally so `channel_inbox(pendingOnly=true)` surfaces it.
   */
  siblingBridgeAgentIds?: ReadonlySet<string>;
  /** Channel identity namespace (defaults to "global"). */
  selfIdentity?: string;
}

export interface ClientBehaviorProfile {
  id: string;
  deliveryMode: "push" | "inbox-first";
  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean;
  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope | null;
  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope | null;
  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null;
}

export interface ResolveClientProfileInput {
  clientName: string;
}

export interface ClientProfileResolver {
  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile;
}

/**
 * Resolves the active client session into one of the three supported Triad
 * agent profiles: Antigravity (`agy`), OpenAI Codex (`codex`), or OpenCode (`opencode`).
 */
export class DefaultClientProfileResolver implements ClientProfileResolver {
  private readonly antigravityProfile = new AntigravityClientProfile();
  private readonly codexProfile = new CodexClientProfile();
  private readonly opencodeProfile = new OpenCodeClientProfile();

  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile {
    const normalized = input.clientName.toLowerCase();

    if (
      normalized === "antigravity" ||
      normalized === "antigravity-cli" ||
      normalized === "agy" ||
      normalized.includes("antigravity")
    ) {
      return this.antigravityProfile;
    }

    if (normalized === "opencode" || normalized.includes("opencode")) {
      return this.opencodeProfile;
    }

    if (normalized === "codex" || normalized === "codex-cli" || normalized.includes("codex")) {
      return this.codexProfile;
    }

    return this.codexProfile;
  }
}
