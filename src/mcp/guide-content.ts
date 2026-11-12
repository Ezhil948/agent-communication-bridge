export type AgentBridgeGuideTopic =
  | "overview"
  | "setup"
  | "send"
  | "reply"
  | "acks"
  | "troubleshooting"
  | "all";

const GUIDE_SECTIONS: Record<Exclude<AgentBridgeGuideTopic, "all">, string> = {
  overview: [
    "# agent-communication-bridge MCP guide",
    "",
    "Use this MCP server to send bidirectional channel messages between Antigravity (`agy`), OpenAI Codex (`codex`), and OpenCode (`opencode`) sessions.",
    "",
    "Tools:",
    "- `agent_bridge_guide(topic?)`: read this usage guide.",
    "- `list_agents(includeClients=true)`: discover peers. Client rows include labels such as `[Antigravity inner]`, `[Codex inner]`, and `[OpenCode]`.",
    "- `message_client_session(...)`: proactively send a message or task to another client session (with optional `model` and `reasoning` overrides).",
    "- `channel_inbox(pendingOnly=true)`: inspect inbound pending conversations and retrieve `replyWith` routing fields.",
    "- `reply(...)`: respond to an inbound pending message using `replyWith` verbatim.",
    "",
    "Every Triad peer receives a message as a new turn in its live session: Antigravity (`agy`) through its language server once attached, Codex (≥ 0.162) through its app-server daemon (or `acb codex start` bridge), and OpenCode through its host inbox plugin. OpenCode sessions auto-create channels with all visible peers on startup.",
  ].join("\n"),
  setup: [
    "# Setup (Antigravity, Codex, OpenCode)",
    "",
    "Antigravity (`agy`):",
    "- Run `agent-communication-bridge antigravity install-plugin` once (installs the `acb` plugin — MCP server, SessionStart/Stop hooks, skill), then restart `agy`.",
    "- On the first turn, the SessionStart hook prompts `agy`'s agent to run `agent-communication-bridge antigravity attach` once so the adapter captures the language-server token. Subsequent messages inject directly into the live conversation.",
    "",
    "Codex (`codex`):",
    "- Run `agent-communication-bridge init --client codex` once (registers the MCP server in `~/.codex/config.toml`).",
    "- Start `codex` normally: Codex ≥ 0.162 receives messages as a new turn in the live TUI via its app-server daemon.",
    "- For headless or older Codex sessions: `agent-communication-bridge codex start --project <path>` launches a dedicated bridge daemon.",
    "",
    "OpenCode (`opencode`):",
    "- Run `agent-communication-bridge opencode install-plugin` (project) or `--global` once.",
    "- Restart OpenCode. The plugin (`<plugins>/agent-communication-bridge/{index.ts,tui.ts}`) queues inbound messages into the `agent-communication-bridge` session and displays a notification in the TUI.",
  ].join("\n"),
  send: [
    "# Sending messages",
    "",
    "Workflow:",
    "1. Call `list_agents(includeClients=true)`.",
    "2. Pick a peer by `agentId`, `project`, or `clientType` (`antigravity`, `codex`, `opencode`).",
    "3. Call `message_client_session(clientId | project, message, expectsResponse?, model?, reasoning?)`.",
    "",
    "`expectsResponse` contract:",
    "- Pass `expectsResponse=true` when you require an answer.",
    "- Pass `expectsResponse=false` for FYI / fire-and-forget updates.",
    "- If omitted, the adapter infers the flag from the message text.",
    "",
    "Optional `model` and `reasoning` overrides:",
    "- Pass `model` (e.g. `'gpt-5.4'` for Codex, `'provider/model'` for OpenCode, or an Antigravity model id) and/or `reasoning` (`'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'` for Codex, OpenCode variant id, or Antigravity thinkingEffort) to switch model or thinking level on that turn.",
  ].join("\n"),
  reply: [
    "# Replying to inbound messages",
    "",
    "Workflow:",
    "1. Call `channel_inbox(pendingOnly=true, includeMessages=true)`.",
    "2. Read the target conversation's `replyWith` block.",
    "3. Call `reply(agentId=replyWith.agentId, conversationId=replyWith.conversationId, replyTo=replyWith.replyTo, message=...)`.",
    "",
    "Always pass `replyWith.agentId` verbatim. For Codex and OpenCode peers, the adapter automatically redirects inner client IDs to their bridge daemon when present while preserving `originalFromAgentId`.",
  ].join("\n"),
  acks: [
    "# Delivery states",
    "",
    "- `queued`: registry created the message record.",
    "- `delivered_to_bridge`: recipient adapter/bridge received the WebSocket event.",
    "- `displayed_to_client`: message was injected into the live session (Antigravity language server, Codex daemon/bridge, or OpenCode host socket).",
    "- `answered`: recipient replied to the message.",
    "- `failed`: permanent delivery failure.",
  ].join("\n"),
  troubleshooting: [
    "# Troubleshooting",
    "",
    "- No peers in `list_agents`: verify the registry is running (`agent-communication-bridge status`) and pass `includeClients=true`.",
    "- Message to Codex not appearing in TUI: run `agent-communication-bridge doctor` to verify `codex ≥ 0.162` and `~/.codex/config.toml` registration, or run `agent-communication-bridge codex start`.",
    "- Stuck at `delivered_to_bridge`: the recipient session is mid-turn or its plugin/attach hook has not run yet. Run `agent-communication-bridge doctor` to inspect native push status for `agy`, `codex`, and `opencode`.",
  ].join("\n"),
};

export function buildAgentBridgeGuide(topic: AgentBridgeGuideTopic): string {
  if (topic === "all") {
    return [
      GUIDE_SECTIONS.overview,
      GUIDE_SECTIONS.setup,
      GUIDE_SECTIONS.send,
      GUIDE_SECTIONS.reply,
      GUIDE_SECTIONS.acks,
      GUIDE_SECTIONS.troubleshooting,
    ].join("\n\n---\n\n");
  }
  return GUIDE_SECTIONS[topic];
}

