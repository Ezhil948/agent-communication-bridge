# Contributing to agent-communication-bridge

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

- **Small fixes** (typos, an obvious bug with a clear fix): open a pull request directly.
- **Features or behavior changes**: open an issue first with the problem and the approach you have in mind. Agreeing on the shape before the code saves both of us a rewrite.
- **Security issues**: do not open a public issue with details. Use GitHub's private vulnerability reporting (repository **Security** tab → *Report a vulnerability*).

## Reporting a bug

Please include:

- What you ran, what you expected, and what happened instead.
- `acb --version` (or the commit you built from), your OS and `node --version`.
- The versions of the clients involved, for example `codex --version`, `opencode --version`, `agy --version`, `claude --version`.
- The output of `acb doctor` and `acb list`.
- Relevant logs:
  - the MCP adapter writes to the client's MCP log;
  - `acb codex start` prints its log path (`<tmpdir>/acb-codex-<pid>.log`);
  - the registry logs to its terminal; the background daemon (`acb up`) writes `.agent-communication-bridge/registry.log` in the directory it was started from.

Strip secrets before posting. `ANTIGRAVITY_CSRF_TOKEN` and any messaging tokens are credentials (Antigravity state is also stored in `$XDG_RUNTIME_DIR/agent-communication-bridge/agy-<pid>.json`), and paths can reveal private project names.

## Development setup

Requirements: Node.js ≥ 22 and pnpm 10.

```bash
git clone <your-repo-url>
cd agent-communication-bridge
pnpm install
pnpm run build
```

- `pnpm dev -- <command>` runs the CLI straight from `src/` (for example `pnpm dev -- list`).
- `bash bin/install.sh` (or `pnpm link --global` on Windows) builds everything and puts your local `acb` / `agent-communication-bridge` on the PATH, so real agent sessions use your build. Restart those sessions after rebuilding: each one keeps the adapter code it started with. The OpenCode plugin is a copy — rerun `acb opencode install-plugin` after changing it (OpenCode 2 reloads its plugin when the file changes).
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so pnpm will not install a dependency version published less than 24 hours ago. That is intentional.

[`docs/development.md`](docs/development.md) has the longer guide: repository layout, builds, and a manual verification checklist.

## Checks — the same ones CI runs

```bash
pnpm run build
pnpm test
pnpm biome check src/ --diagnostic-level=error
```

`pnpm lint` shows warnings and infos too. Fix the ones you touch, but only errors fail CI.

**Running the tests from inside an agent session.** A live session may export environment variables such as `AGENT_BRIDGE_PROJECT` or `AGENT_BRIDGE_IDENTITY` to child processes. Check your environment so tests stay isolated in temp directories.

### Writing tests

- Vitest. Only `src/**/*.test.ts` is collected — the compiled copies in `dist/` are excluded on purpose.
- New logic that branches, parses, loops or touches delivery needs at least one test that fails if it breaks. One-liners don't.
- Never point a test at the live registry on `:4999` or at a real inbox socket (or the host inbox sockets under `$XDG_RUNTIME_DIR/agent-communication-bridge/`):
  - use a temp directory;
  - set `HOME` to it, because the registry database lives under `~/.agent-communication-bridge/`;
  - use another port;
  - use a socket server you create yourself, or point `XDG_RUNTIME_DIR` at the temp directory.
- Unix socket paths are capped at about 108 bytes. Keep temp socket paths short.
- Never print or log a token's value (`ANTIGRAVITY_CSRF_TOKEN`) — only its name or whether it is present.

### Trying delivery end to end

Two or three terminals on the same identity, in different projects. Run `acb init --yes --client codex,opencode,antigravity --identity e2e` once in each project, then verify `acb doctor` and `acb list`.

Ask the first session to message the other, for example "send project B a message asking for its git branch". It should arrive in the second session as a new turn, even if that session is idle. Then its reply should arrive back as a turn in the first session. `acb list` shows active peers, and `channel_inbox` / registry endpoints inspect conversations and ACK states.

Delivery needs live agents, so a change to it is verified by hand on top of the unit tests: send a message to each affected client and check that it starts a turn there, that the client answers with `reply`, and that it can send with `message_client_session`.

## Code guidelines

- TypeScript strict, ESM, Node built-ins first. Discuss a new runtime dependency in an issue before adding it.
- Keep changes small and focused, and match the surrounding code. Comments explain *why*, not what.
- Client-specific behavior lives in its own module under `src/client/` (one per client: Codex, OpenCode, Antigravity). Undocumented or unstable client APIs stay isolated in a single file, so a client upgrade breaks one place.
- The injection prompt lives only in `src/client/injection-prompt.ts`; the adapter wraps every message before it reaches a client. `src/__tests__/injection-prompt.test.ts` locks the contract.
- Keep `listenHostInbox` in sync across `src/client/host-inbox-socket.ts` and `src/client/opencode-plugin/agent-bridge.ts`, including message-id dedupe.
- The OpenCode plugin ships as two files: `agent-bridge.ts` (installed as `index.ts`, the server half) and `tui.ts` (the terminal half). The build copies both to `dist/`.
- agy reads `plugins/agent-communication-bridge/hooks.json` (agy's hook format) from the plugin root; Codex reads `plugins/agent-communication-bridge/hooks/hooks.json`. They are different files on purpose.
- User-visible changes update the docs in the same pull request:
  - `README.md`;
  - `docs/cli-reference.md` for commands and flags;
  - `plugins/agent-communication-bridge/skills/agent-bridge/SKILL.md` if agents should behave differently.

## Commits and pull requests

- Branch from `main` (or your integration branch) and use conventional commits with the area as scope, for example:
  - `fix(codex): reconnect when the app-server WebSocket drops`
  - `feat(cli): …`
  - `docs: …`
- The commit body explains why the change is needed.
- The PR description covers:
  - the problem;
  - the approach;
  - how you tested it (commands and their output).
- CI must be green before review.

## Project map

| Path | What lives there |
| :--- | :--- |
| `src/registry/` | Registry daemon: HTTP + WebSocket API, SQLite channel store |
| `src/mcp/adapter.ts` | MCP adapter each client session spawns; tools and per-client delivery |
| `src/client/` | Per-client delivery and helpers (Codex daemon, host inbox socket, OpenCode plugin, agy language server) |
| `src/cli/commands/` | One file per `acb` command |
| `plugins/agent-communication-bridge/` | Plugin for Antigravity (agy) and Codex: MCP entry, skill, commands, hooks |
| `docs/` | Longer-form docs (Spanish): architecture, messaging flow, CLI reference |

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
