import { describe, expect, it } from "vitest";
import { CodexClientProfile } from "../client/profiles/codex-client-profile.js";
import { OpenCodeClientProfile } from "../client/profiles/opencode-client-profile.js";
import type { ChannelMessage } from "../types/messages.js";

/**
 * Regression tests for the bridge-sibling acceptance fix.
 *
 * Codex and OpenCode sessions can register two entries in the registry —
 *   1. the bridge daemon  (`client-{codex,opencode}-bridge-*`)
 *   2. the inner MCP client (`client-{codex,opencode}-mcp-client-*`)
 * The adapter auto-redirects outbound `toAgentId` to the bridge for delivery.
 * The inner client must still recognize that rewritten message as locally
 * addressable so it surfaces in `channel_inbox(pendingOnly=true)`.
 */

const CODEX_INNER = "client-codex-mcp-client-aaaa";
const CODEX_BRIDGE = "client-codex-bridge-aaaa";

function makeMessage(toAgentId: string | undefined): ChannelMessage {
  return {
    conversationId: "conv-1",
    messageId: "msg-1",
    fromAgentId: "client-antigravity-zzzz",
    fromAgentName: "antigravity",
    toAgentId,
    kind: "chat",
    content: "hi",
    createdAt: Date.now(),
  };
}

describe("CodexClientProfile.acceptsChannelMessage — sibling bridge", () => {
  const profile = new CodexClientProfile();

  it("accepts broadcast (no toAgentId) regardless of context", () => {
    expect(profile.acceptsChannelMessage(makeMessage(undefined), CODEX_INNER)).toBe(true);
    expect(
      profile.acceptsChannelMessage(makeMessage(undefined), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(true);
  });

  it("accepts a message addressed to selfAgentId", () => {
    expect(profile.acceptsChannelMessage(makeMessage(CODEX_INNER), CODEX_INNER)).toBe(true);
  });

  it("regression guard: without ctx, rejects messages addressed to the sibling bridge", () => {
    expect(profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), CODEX_INNER)).toBe(false);
  });

  it("with ctx.siblingBridgeAgentIds, accepts messages addressed to the sibling bridge", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(true);
  });

  it("rejects messages addressed to a foreign agent even with ctx", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage("client-other-cccc"), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(false);
  });
});

describe("OpenCodeClientProfile.acceptsChannelMessage — sibling bridge", () => {
  const profile = new OpenCodeClientProfile();
  const OPENCODE_INNER = "client-opencode-zzzz";
  const OPENCODE_BRIDGE = "client-opencode-bridge-zzzz";

  it("accepts messages addressed to its sibling bridge when present in ctx", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(OPENCODE_BRIDGE), OPENCODE_INNER, {
        siblingBridgeAgentIds: new Set([OPENCODE_BRIDGE]),
      }),
    ).toBe(true);
  });

  it("does NOT accept messages addressed to a foreign bridge", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), OPENCODE_INNER, {
        siblingBridgeAgentIds: new Set([OPENCODE_BRIDGE]),
      }),
    ).toBe(false);
  });
});
