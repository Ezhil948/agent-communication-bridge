import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type {
  AcceptsChannelMessageContext,
  ClientBehaviorProfile,
  ClientNotificationEnvelope,
  LegacyNotifyPayload,
} from "../client-profile-resolver.js";

function wrapNotification(content: string, meta: Record<string, unknown>): ClientNotificationEnvelope {
  return {
    method: "notifications/message",
    params: {
      level: "info",
      logger: "agent-communication-bridge.opencode",
      data: { content, meta },
    },
  };
}

export class OpenCodeClientProfile implements ClientBehaviorProfile {
  readonly id: string = "opencode";
  readonly deliveryMode = "push" as const;

  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean {
    if ((message.identity ?? "global") !== (ctx?.selfIdentity ?? "global")) return false;
    if (!message.toAgentId || message.toAgentId === "opencode") return true;
    if (selfAgentId !== null && message.toAgentId === selfAgentId) return true;
    return Boolean(ctx?.siblingBridgeAgentIds?.has(message.toAgentId));
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return wrapNotification(message.content, {
      from_agent: message.fromAgentId,
      ...(message.fromAgentName ? { agent_name: message.fromAgentName } : {}),
      conversation_id: message.conversationId,
      message_id: message.messageId,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      ...(message.taskId ? { task_id: message.taskId } : {}),
      kind: message.kind,
      ...message.meta,
    });
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope {
    return wrapNotification(payload.content, {
      ...(payload.agentId ? { from_agent: payload.agentId } : {}),
      ...(payload.agentName ? { agent_name: payload.agentName } : {}),
      conversation_id: payload.conversationId ?? randomUUID(),
      message_id: payload.messageId ?? randomUUID(),
      ...payload.meta,
    });
  }

  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    const content = payload?.message || JSON.stringify(payload);
    return wrapNotification(content, {
      from_agent: message.fromAgentId ?? "",
      task_id: message.taskId ?? "",
      ...(payload?.skillId ? { skill_id: payload.skillId } : {}),
    });
  }
}
