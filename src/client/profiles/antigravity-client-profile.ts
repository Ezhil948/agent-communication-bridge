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
      logger: "agent-communication-bridge.channel",
      data: { content, meta },
    },
  };
}

function formatInboxSummary(input: {
  fromAgentId?: string;
  fromAgentName?: string;
  conversationId?: string;
  content?: string;
  taskId?: string;
}): string {
  const sender = input.fromAgentName ?? input.fromAgentId ?? "unknown sender";
  const trimmed = input.content?.trim() ?? "";
  const preview = trimmed ? ` Preview: ${trimmed.slice(0, 160)}${trimmed.length > 160 ? "…" : ""}` : "";
  const conv = input.conversationId ? ` Conversation: ${input.conversationId}.` : "";
  const task = input.taskId ? ` Task: ${input.taskId}.` : "";
  return `New channel message from ${sender}.${conv}${task} Antigravity handles channels as inbox-first state. Use channel_inbox to inspect it and reply.${preview}`;
}

export class AntigravityClientProfile implements ClientBehaviorProfile {
  readonly id = "antigravity";
  readonly deliveryMode = "inbox-first" as const;

  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean {
    if ((message.identity ?? "global") !== (ctx?.selfIdentity ?? "global")) return false;
    if (!message.toAgentId) return true;
    if (selfAgentId !== null && message.toAgentId === selfAgentId) return true;
    return Boolean(ctx?.siblingBridgeAgentIds?.has(message.toAgentId));
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return wrapNotification(
      formatInboxSummary({
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        conversationId: message.conversationId,
        content: message.content,
        taskId: message.taskId,
      }),
      {
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        conversationId: message.conversationId,
        messageId: message.messageId,
        replyTo: message.replyTo,
        taskId: message.taskId,
        kind: message.kind,
        ...message.meta,
      },
    );
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope {
    return wrapNotification(
      formatInboxSummary({
        fromAgentId: payload.agentId,
        fromAgentName: payload.agentName,
        conversationId: payload.conversationId,
        content: payload.content,
      }),
      {
        fromAgentId: payload.agentId,
        fromAgentName: payload.agentName,
        conversationId: payload.conversationId ?? randomUUID(),
        messageId: payload.messageId ?? randomUUID(),
        ...payload.meta,
      },
    );
  }

  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    return wrapNotification(
      formatInboxSummary({
        fromAgentId: message.fromAgentId,
        conversationId: message.taskId,
        content: payload?.message ?? JSON.stringify(payload),
        taskId: message.taskId,
      }),
      {
        fromAgentId: message.fromAgentId,
        taskId: message.taskId,
        skillId: payload?.skillId,
        type: message.type,
      },
    );
  }
}
