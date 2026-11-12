---
description: Check that agent-communication-bridge is installed, the registry is up, and this session is registered
argument-hint: '[--identity <name>]'
allowed-tools: Bash(agent-communication-bridge:*), Bash(acb:*), Bash(npm:*), AskUserQuestion
---

Diagnose the agent-communication-bridge setup for this machine and report what the user must fix.

Raw slash-command arguments: `$ARGUMENTS`

Run these checks in order and report a short checklist (✓ / ✗ per line). Do not
fix anything before reporting, except where a step says you may offer.

1. **CLI present** — run `agent-communication-bridge --version`.
   - If the command is not found, the plugin's MCP server cannot start either,
     because it invokes the same binary. Tell the user to install it with
     `npm install -g agent-communication-bridge` and stop; nothing else will work.

2. **Registry running** — run `agent-communication-bridge status`.
   - If it is down, offer (via AskUserQuestion) to start it with
     `agent-communication-bridge up`. It is a background daemon; no terminal stays busy.

3. **Peers visible** — run `agent-communication-bridge list`.
   - Report how many sessions are registered and their identities.
   - A session only sees peers that share its channel identity. If the user
     passed `--identity <name>`, point out any peer NOT on that identity, since
     those are invisible to each other by design.

4. **This session registered** — check whether `agent-communication-bridge list` includes
   an entry whose path matches the current working directory.
   - If it is missing, the MCP server in this session has not connected. Tell the
     user to restart the session so the plugin's MCP server starts.

5. **Live delivery** — run `agent-communication-bridge doctor` and report its
   `(native push)` lines for every installed Triad client:
   - **Antigravity (`agy` ≥ 1.3)**: install plugin once with `acb antigravity install-plugin`.
   - **Codex (`codex` ≥ 0.162)**: gets incoming messages as a new turn in the live session (`acb init --client codex`); older or headless setups use `acb codex start`.
   - **OpenCode (`opencode`)**: install plugin once with `acb opencode install-plugin`.
   - Report any failed doctor check verbatim, including its suggested fix.

Close with the single most important next action, or "Everything is ready." when
all five checks pass.
