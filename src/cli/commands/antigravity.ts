import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { appendOriginalRequest } from "../../client/antigravity-agents-file.js";
import {
  buildSessionStartHookOutput,
  buildStopHookOutput,
} from "../../client/antigravity-hooks.js";
import { collectPendingForClient } from "../../client/antigravity-pending.js";
import { AntigravityLsBridgeService } from "../../client/antigravity-ls-bridge-service.js";
import { lsTargetFromEnv, readAgyConversation, writeAgyConversation } from "../../client/antigravity-ls-client.js";
import { getParentProcessEntries } from "../../client/process-ancestors.js";
import { RegistryClient } from "../../client/registry-client.js";
import { pathsEqual } from "../../utils/path.js";
import { execBinarySync } from "../../utils/process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read all of stdin (hook event payload). Resolves "" if nothing is piped. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Emit the hook result as JSON on stdout (Antigravity parses stdout as JSON). */
function emitHookOutput(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}

interface HookPayload {
  conversationId?: string;
  workspacePaths?: string[];
}

function parseHookPayload(raw: string): HookPayload {
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

/** The agy process running this hook. agy runs hooks through `sh -c` or `cmd.exe`, so skip shells. */
function agyPidOfHook(): number | undefined {
  const shellNames = new Set([
    "sh",
    "bash",
    "dash",
    "zsh",
    "env",
    "powershell",
    "pwsh",
    "cmd",
  ]);

  const entries = getParentProcessEntries(process.ppid, 6);
  for (const entry of entries) {
    if (!entry.name) continue;
    const processName = basename(entry.name)
      .toLowerCase()
      .replace(/\.(exe|cmd|bat)$/, "");
    if (!shellNames.has(processName)) return entry.pid;
  }

  return undefined;
}

/**
 * Hand this session's conversation to the MCP adapter, which then starts turns
 * in it while agy is idle. Only `attach` (run by agy's agent) sees the LS token;
 * hooks only see the conversation, so they refresh the one `attach` recorded —
 * that follows /new and resumes. Returns whether live delivery is on.
 */
function recordAgyConversation(payload: HookPayload): boolean {
  try {
    const agyPid = agyPidOfHook();
    const projectPath = payload.workspacePaths?.[0] ? resolve(payload.workspacePaths[0]) : process.cwd();
    const target = lsTargetFromEnv() ?? (agyPid ? readAgyConversation(agyPid, process.env, projectPath) : undefined);
    const cascadeId = payload.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID;
    if (target?.csrf && cascadeId && agyPid) {
      writeAgyConversation(agyPid, { url: target.url, csrf: target.csrf, cascadeId, projectPath });
      return true;
    }
    // agy logs hook stderr: say which piece is missing (names only, never values).
    const missing = [!target?.csrf && "LS address/token (run `agent-communication-bridge antigravity attach` from agy)", !cascadeId && "conversation id", !agyPid && "agy pid"];
    console.error(`[antigravity] live delivery off — missing ${missing.filter(Boolean).join(", ")}`);
  } catch (err) {
    console.error("[antigravity] could not record the conversation:", err instanceof Error ? err.message : err);
  }
  return false;
}

export async function resolveClientId(
  registry: RegistryClient,
  project: string,
  clientId?: string,
  identity?: string,
  agyPid?: number,
): Promise<string | undefined> {
  if (clientId) return clientId;
  const wantedIdentity = identity ?? "global";
  const isAntigravityClient = (name: string | undefined) =>
    typeof name === "string" && /antigravity|agy/i.test(name);

  if (typeof agyPid === "number") {
    const allClients = await registry.listAgents({ entryType: "client" });
    const exactAgy = allClients.find(
      (a) =>
        (a.identity ?? "global") === wantedIdentity &&
        Array.isArray(a.ancestorPids) &&
        a.ancestorPids.includes(agyPid) &&
        (isAntigravityClient(a.clientInfo?.clientName) || a.clientInfo?.clientName === "mcp-client"),
    );
    if (exactAgy) return exactAgy.agentId;
  }

  const agents = await registry.listAgents({ project });
  const sameProjectAntigravity = agents.filter(
    (a) =>
      a.entryType === "client" &&
      (a.identity ?? "global") === wantedIdentity &&
      pathsEqual(a.projectPath, project) &&
      isAntigravityClient(a.clientInfo?.clientName),
  );
  const match =
    sameProjectAntigravity.find((a) => a.healthy) ??
    sameProjectAntigravity[0] ??
    agents.find(
      (a) =>
        a.entryType === "client" &&
        (a.identity ?? "global") === wantedIdentity &&
        isAntigravityClient(a.clientInfo?.clientName),
    );
  if (match) return match.agentId;
  // Strictly enforce identity wall: never fall through to global or unrelated identities
  // when an explicit non-global identity namespace was requested.
  if (identity) return undefined;
  const anySameIdentity = agents.find(
    (a) =>
      a.entryType === "client" &&
      (a.identity ?? "global") === "global" &&
      (isAntigravityClient(a.clientInfo?.clientName) || a.clientInfo?.clientName === "mcp-client"),
  );
  return anySameIdentity?.agentId;
}

export function registerAntigravityCommand(program: Command): void {
  const antigravity = program
    .command("antigravity")
    .description("Antigravity CLI (`agy`) integration: native channels via MCP + hooks");

  // ── antigravity install-plugin ───────────────────────────────────────────────
  // The shared plugin carries agy's pieces: mcp_config.json, hooks.json (the hooks
  // that hand the adapter agy's live conversation) and the skill.
  antigravity
    .command("install-plugin")
    .description("Install the agent-communication-bridge plugin into agy: MCP server, hooks for live delivery, and the skill")
    .action(() => {
      const pluginDir = resolve(__dirname, "../../../plugins/agent-communication-bridge");
      if (!existsSync(join(pluginDir, "plugin.json"))) {
        console.error(chalk.red("✗") + ` plugin not found at ${pluginDir}`);
        process.exit(1);
      }
      try {
        execBinarySync("agy", ["plugin", "install", pluginDir], { stdio: "inherit" });
      } catch {
        console.error(chalk.red("✗") + " `agy plugin install` failed — is agy ≥ 1.3 on PATH?");
        process.exit(1);
      }
      // Where the sidecar lived before plugins carried it; agy no longer loads it.
      rmSync(join(homedir(), ".gemini", "config", "sidecars", "open-agent-bridge"), { recursive: true, force: true });
      rmSync(join(homedir(), ".gemini", "config", "sidecars", "agent-communication-bridge"), { recursive: true, force: true });
      console.log(chalk.green("✓") + " agent-communication-bridge plugin installed in agy — restart agy to load it.");
    });

  // ── antigravity attach ───────────────────────────────────────────────────────
  // agy gives its LS address and token to the commands its agent runs, not to
  // hooks or MCP servers — so the agent runs this once per conversation.
  antigravity
    .command("attach")
    .description("Run from inside agy (by its agent): let agent-communication-bridge start turns in this conversation")
    .action(() => {
      if (recordAgyConversation({})) console.log("agent-communication-bridge: live delivery on for this agy session.");
      else process.exitCode = 1;
    });

  // ── antigravity hook-stop ────────────────────────────────────────────────────
  antigravity
    .command("hook-stop")
    .description("Stop hook: deliver pending channel messages and force agy to continue")
    .option("--project <path>", "Workspace path (default: the hook's workspace)")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      const payload = parseHookPayload(await readStdin());
      recordAgyConversation(payload);
      // Plugin hooks run in the plugin's directory, not the workspace.
      const project: string = options.project ?? payload.workspacePaths?.[0] ?? process.cwd();
      const agyPid = agyPidOfHook();
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, project, options.clientId, options.identity, agyPid);
        if (!clientId) {
          emitHookOutput({});
          return;
        }

        const pending = await collectPendingForClient(registry, clientId, { identity: options.identity });
        for (const msg of pending) {
          appendOriginalRequest(project, {
            messageId: msg.messageId,
            fromAgentId: msg.fromAgentId,
            fromAgentName: msg.fromAgentName,
            conversationId: msg.conversationId,
            content: msg.content,
            timestampIso: new Date().toISOString(),
          });
        }

        emitHookOutput(buildStopHookOutput(pending));
      } catch (err) {
        console.error("[antigravity hook-stop]", err instanceof Error ? err.message : err);
        emitHookOutput({}); // never block the agent on a bridge error
      }
    });

  // ── antigravity hook-session-start ───────────────────────────────────────────
  antigravity
    .command("hook-session-start")
    .description("SessionStart hook: attach live delivery and surface pending channel messages")
    .option("--project <path>", "Workspace path (default: the hook's workspace)")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      const payload = parseHookPayload(await readStdin());
      const attached = recordAgyConversation(payload);
      const project: string = options.project ?? payload.workspacePaths?.[0] ?? process.cwd();
      let pending = 0;
      const agyPid = agyPidOfHook();
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, project, options.clientId, options.identity, agyPid);
        if (clientId) pending = (await collectPendingForClient(registry, clientId, { identity: options.identity })).length;
      } catch (err) {
        console.error("[antigravity hook-session-start]", err instanceof Error ? err.message : err);
      }
      emitHookOutput(buildSessionStartHookOutput(pending, { attached }));
    });

  // ── antigravity ls-push ──────────────────────────────────────────────────────
  antigravity
    .command("ls-push")
    .description(
      "Legacy (agy < 1.3): poll the registry and deliver into a live agy TUI via its " +
        "language server. agy ≥ 1.3 refuses these calls without its CSRF token; use " +
        "`install-plugin` + `attach` instead.",
    )
    .option("--project <path>", "Workspace path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--identity <id>", "Channel namespace of the agy session (default: global)")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--poll-interval-ms <n>", "Polling interval in ms", "2000")
    .option("--retry-interval-ms <n>", "Re-injection blackout per message in ms", "30000")
    .option("--once", "Run a single poll cycle and exit")
    .option("--verbose", "Verbose logs")
    .action(async (options) => {
      const service = new AntigravityLsBridgeService({
        projectPath: options.project,
        registryUrl: options.registryUrl,
        identity: options.identity,
        clientId: options.clientId,
        pollIntervalMs: Number(options.pollIntervalMs),
        retryIntervalMs: Number(options.retryIntervalMs),
        verbose: options.verbose ?? true,
      });
      if (options.once) {
        const n = await service.runOnce();
        console.error(`[antigravity ls-push] injected ${n} message(s)`);
        return;
      }
      console.error(
        chalk.green("✓") +
          ` Antigravity ls-push running (project: ${options.project}, identity: ${options.identity ?? "global"}). Ctrl-C to stop.`,
      );
      await service.start();
    });
}
