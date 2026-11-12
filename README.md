# agent-communication-bridge

Local Model Context Protocol (MCP) server, registry, and client hooks for messaging between Antigravity (`agy`), OpenAI Codex (`codex`), and OpenCode (`opencode`) sessions on the same machine.

## How it works

- **Registry (`http://localhost:4999`)**: An Express + WebSocket + SQLite server that tracks active sessions, stores messages, and records delivery states (`queued`, `delivered_to_bridge`, `displayed_to_client`, `answered`, `failed`).
- **MCP server (`acb mcp start`)**: Exposes messaging tools inside each client and resolves the active workspace path from the host or parent process so separate projects do not collide on a plugin directory.
- **Session isolation**: Each live session gets a unique `agentId` (`client-<type>-<projectHash>-<sessionTag>`). Multiple windows or sessions in the same project stay separate without kicking each other off the WebSocket.
- **Turn delivery**: Antigravity hooks (`SessionStart` / `Stop` + Language Server), Codex app-server (`codex >= 0.162` or `acb codex app-bridge`), and the OpenCode plugin start a turn in the receiving session when a message arrives.

## Requirements

- Node.js >= 22
- `pnpm`
- At least one client installed: `agy`, `codex`, or `opencode`

## Install

```bash
git clone https://github.com/Ezhil948/agent-communication-bridge.git
cd agent-communication-bridge
pnpm install
pnpm run build
npm install -g .
```

On macOS, Linux, or Git Bash you can run `bash bin/install.sh` instead.

This installs both `agent-communication-bridge` and `acb` on `PATH`.

## Setup

Start the registry and configure the clients you use (one-time per machine):

```bash
acb up
acb antigravity install-plugin
acb init --client codex --yes
acb opencode install-plugin --global
acb doctor
```

For per-project configuration (writes `.mcp.json` and optionally scopes sessions with `--identity`), run `acb init` inside the project directory.

## Usage

1. Open your project in two clients (or start a headless Codex worker with `acb codex app-bridge --project "<path>"`).
2. From one session, call `list_agents(includeClients=true)` to find the target's `agentId`.
3. Call `message_client_session(clientId, message, expectsResponse=true)`. Optionally pass `model` or `reasoning` to override them for that turn.
4. The receiving session wakes up, reads `channel_inbox(pendingOnly=true)` if needed, and answers via `reply` using `replyWith.agentId`, `replyWith.conversationId`, and `replyWith.replyTo`.

## MCP tools

| Tool | Purpose |
| :--- | :--- |
| `list_agents` | List connected agents and client sessions (`includeClients=true`). |
| `message_client_session` | Send a message by `clientId` or `project`, with optional `expectsResponse`, `model`, and `reasoning`. |
| `channel_inbox` | Read pending or recent threads (`pendingOnly=true` / `false`). |
| `reply` | Reply to a thread using the `replyWith` fields from `channel_inbox`. |
| `channel_clear` | Clear `answered`, `failed`, `all`, or a specific `conversationId`. |
| `agent_bridge_guide` | Return inline usage docs by topic (`overview`, `setup`, `send`, `reply`, `acks`, `troubleshooting`). |

## CLI

```bash
acb up                         # Start background registry on :4999
acb down                       # Stop background registry
acb status                     # Show registry status and agent count
acb list                       # List registered sessions
acb prune                      # Remove stale entries
acb doctor                     # Check Node, PATH, registry, and client plugins
acb init [--project <path>]    # Write .mcp.json and configure clients
acb antigravity <cmd>          # install-plugin | attach | hook-stop | hook-session-start
acb codex <cmd>                # start | app-bridge | tmux-bind | tmux-sidecar
acb opencode <cmd>             # start | bridge | install-plugin
acb prompt <cmd>               # path | show | init | edit | reset
```

## Notes

- Separate windows, CLI processes, and projects run as isolated sessions. If one IDE window shares a single MCP child process across multiple tabs, those tabs share that client connection unless separated with `--identity`.
- See [docs/architecture.md](docs/architecture.md), [docs/cli-reference.md](docs/cli-reference.md), and [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT
