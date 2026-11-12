---
name: agent-bridge
description: Operational reference for connecting and communicating across Antigravity (agy), OpenAI Codex, and OpenCode sessions via the agent-communication-bridge (acb) MCP server. Covers peer discovery, headless/live connection, sending and replying to messages, per-turn model and reasoning overrides, delivery verification, identity namespaces, and troubleshooting — adaptable to any task the user requests.
---

# Agent Communication Bridge (`agent-communication-bridge` / `acb`)

`agent-communication-bridge` connects live **Antigravity (`agy`)**, **OpenAI Codex (`codex`)**, and **OpenCode (`opencode`)** sessions on the same machine through a shared local registry (`http://localhost:4999`) and MCP server. Use these tools flexibly to collaborate, delegate, review, or exchange information in whatever way fits the user's request.

---

## 1. MCP Tools

| Tool | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `list_agents` | Discover connected peers | Pass `includeClients=true` to list active Antigravity, Codex, and OpenCode sessions. |
| `message_client_session` | Send a message to a peer | `clientId` or `project`, `message` (string), `expectsResponse` (`true` / `false`), optional `model`, optional `reasoning`. |
| `channel_inbox` | Read inbound & pending threads | `pendingOnly=true` (awaiting reply) or `pendingOnly=false` (recent history). |
| `reply` | Reply to an inbound message | Copy `agentId`, `conversationId`, `replyTo` verbatim from `replyWith`, plus `message`. |
| `channel_clear` | Clean up inbox threads | `scope`: `"answered"` \| `"failed"` \| `"all"` \| specific `conversationId`. |
| `agent_bridge_guide` | Built-in reference by topic | `topic`: `"overview"`, `"setup"`, `"send"`, `"reply"`, `"acks"`, `"troubleshooting"`, `"all"`. |

---

## 2. Peer Types & Routing

`list_agents(includeClients=true)` classifies each connected session:

| `peerType` | Label | Meaning | Send target? |
| :--- | :--- | :--- | :--- |
| `antigravity-inner` | `[Antigravity inner]` | MCP client inside an Antigravity (`agy`) session. | ✅ Yes |
| `codex-inner` | `[Codex inner]` | MCP client inside a Codex CLI session. | ✅ Yes (auto-routes to bridge if present) |
| `codex-bridge` | `[Codex bridge]` | Headless Codex app-server bridge (`acb codex app-bridge` / `start`). | ✅ Yes |
| `opencode-code` | `[OpenCode]` | MCP client inside an OpenCode session. | ✅ Yes |
| `opencode-bridge` | `[OpenCode bridge]` | OpenCode bridge daemon. | ✅ Yes |

**Note on Codex pairing:** A Codex session started with `acb codex app-bridge` or `acb codex start` registers both a bridge entry (`client-codex-bridge-*`) and an inner MCP client (`client-codex-mcp-client-*`). Messaging either `agentId` works.

---

## 3. How to Connect Peers (If Not Already Online)

Always call `list_agents(includeClients=true)` first. If a target peer is not listed:

1. **Ensure the registry is running**:
   ```bash
   acb status   # if down: acb up
   ```
2. **Codex (headless background bridge)**:
   ```bash
   acb codex app-bridge --project "<workspace-path>" [--model <model>] [--effort <level>]
   ```
   Or run `codex` (≥ 0.162) directly in a terminal for native TUI delivery.
3. **OpenCode**:
   - Interactive: open OpenCode / OpenCode Desktop in the workspace.
   - Headless (if `opencode-cli.exe` is available, e.g. from OpenCode Desktop):
     1. Start `opencode-cli serve --port 4096` (with `OPENCODE_SERVER_PASSWORD` set).
     2. Create and prompt a session via `opencode-cli api --server http://127.0.0.1:4096 session.create` and `session.prompt` so OpenCode loads the `agent-communication-bridge` MCP plugin and registers `[OpenCode]`.
4. **Antigravity (`agy`)**:
   - Ensure the plugin is installed (`acb antigravity install-plugin`), and attach live delivery if needed with `acb antigravity attach`.

---

## 4. Communicating Across Sessions

### Sending a Message (and Switching Model / Reasoning at Any Point)
1. Call `list_agents(includeClients=true)` to find the target's `agentId` (or `project` path).
2. Call `message_client_session`:
   - Pass `clientId` (preferred when multiple peers share a project) or `project`.
   - Set `expectsResponse: true` when you need an answer, or `expectsResponse: false` for fire-and-forget updates (if omitted, the bridge infers intent from the message text).
   - **Per-turn `model` and `reasoning` overrides** (optional, supported on all three runtimes):
     - `model`: e.g. `'gpt-5.4'` for Codex, `'provider/model'` (or `'provider/model#variant'`) for OpenCode, or an Antigravity model id.
     - `reasoning`: e.g. `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'` for Codex, OpenCode variant id, or Antigravity `thinkingEffort`.
3. Wait for the peer's reply to arrive as a new turn, or check `channel_inbox(pendingOnly=false)`.

### Replying to an Inbound Message
1. Call `channel_inbox(pendingOnly=true)` to inspect pending messages.
2. Each pending entry includes a `replyWith` object (`agentId`, `conversationId`, `replyTo`).
3. Call `reply` with those three fields **copied verbatim** — never re-derive or swap `agentId`.

---

## 5. Delivery States (ACKs)

| State | Meaning |
| :--- | :--- |
| `queued` | Persisted by the registry; not yet pushed. |
| `delivered_to_bridge` | Received by the recipient's adapter or bridge daemon over WebSocket. |
| `displayed_to_client` | Delivered into the recipient's live session (LS cascade, Codex turn, or OpenCode host inbox socket). |
| `answered` | Recipient replied via `reply`. |
| `failed` | Delivery failed or expired before a reply. |

`delivered_to_bridge` means the transport received it, not that the peer LLM has finished reading it. Look for `displayed_to_client` or `answered` to confirm live session delivery.

---

## 6. Identity Namespaces & Setup Diagnostics

- **Identities (`AGENT_BRIDGE_IDENTITY`)**: Sessions only see peers and messages in the same `--identity` namespace (default: `"global"`). Keep peers in the same namespace when they need to communicate, or isolate separate tasks with distinct identities.
- **One-time client setup**:
  - Antigravity: `acb antigravity install-plugin`
  - Codex: `acb init --client codex`
  - OpenCode: `acb opencode install-plugin --global`
- **Diagnostics**: Run `acb doctor` to verify CLI binaries, registry reachability, and native push plugins/hooks.
