import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { McpAgentBridge } from "../../mcp/adapter.js";
import {
  MCP_SERVER_NAME,
  buildMcpServerEntry,
  writeMcpConfig,
  defaultMcpMode,
  type McpConfigMode,
} from "../lib/mcp-config.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("MCP adapter — connect agent-communication-bridge to Antigravity (agy), Codex, or OpenCode");

  mcp
    .command("start")
    .description(
      "Start MCP adapter in stdio mode (used by Antigravity, Codex, and OpenCode). " +
        "Auto-starts an embedded registry and local agent if none are running.",
    )
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path for client registration (default: cwd)")
    .option("--identity <id>", "Channel namespace — only sessions sharing it see each other (default: global)")
    .option("--no-auto", "Disable auto-start of registry (require manual setup)")
    .action(async (options) => {
      const explicitProject = options.project ?? process.env["AGENT_BRIDGE_PROJECT"];
      const bridge = new McpAgentBridge({
        registryUrl: options.registryUrl,
        auto: options.auto !== false,
        projectPath: explicitProject ?? process.cwd(),
        projectPathExplicit: Boolean(explicitProject),
        identity: options.identity ?? process.env["AGENT_BRIDGE_IDENTITY"],
      });
      await bridge.start("stdio");
    });

  mcp
    .command("server")
    .description("Start MCP adapter as an HTTP/SSE server")
    .option("-p, --port <number>", "HTTP port", "6000")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const bridge = new McpAgentBridge({
        registryUrl: options.registryUrl,
      });
      console.error(chalk.cyan("[MCP Server] Starting HTTP/SSE MCP server..."));
      await bridge.start("http", parseInt(options.port, 10));
    });

  mcp
    .command("config")
    .description("Print or write the .mcp.json entry that adds agent-communication-bridge to an MCP client")
    .option("--write", "Write (and merge into) .mcp.json in the current directory")
    .option("--identity <id>", "Channel namespace to bake into the config (default: global)")
    .option("--global", "Use the globally-installed binary by name (agent-communication-bridge)")
    .option("--local", "Use node + the resolved dist path (no global install needed)")
    .action(async (options) => {
      const projectPath = resolve(process.cwd());
      const mode: McpConfigMode = options.global
        ? "linked"
        : options.local
          ? "local"
          : defaultMcpMode();

      const entry = buildMcpServerEntry({ projectPath, identity: options.identity, mode });
      const json = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2);

      if (options.write) {
        const { merged } = writeMcpConfig(resolve(".mcp.json"), entry);
        console.log(chalk.green("✓") + ` .mcp.json ${merged ? "updated" : "written"}`);
        console.log(chalk.dim(`  Project:  ${projectPath}`));
        if (options.identity) console.log(chalk.dim(`  Identity: ${options.identity}`));
        console.log(chalk.dim(`  Mode:     ${mode}`));
      } else {
        console.log("\n" + chalk.bold("Add to your .mcp.json:") + "\n");
        console.log(json);
        console.log();
        console.log(chalk.dim("Or run: agent-communication-bridge mcp config --write"));
      }
    });

  mcp
    .command("status")
    .description("Show what agents and tools are available to an MCP client right now")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const { RegistryClient } = await import("../../client/registry-client.js");
      const client = new RegistryClient(options.registryUrl);

      try {
        const agents = await client.listAgents({ healthy: true });

        if (agents.length === 0) {
          console.log(chalk.yellow("No healthy agents found. Start agents with: agent-communication-bridge start <path>"));
          return;
        }

        console.log(chalk.bold(`\n${agents.length} agent(s) connected — MCP tools registered:\n`));

        const tools = ["list_agents", "message_client_session", "reply", "channel_inbox", "channel_clear"];
        console.log(chalk.cyan("  Channel tools:"));
        for (const t of tools) console.log(`    • ${t}`);
        console.log();

        for (const agent of agents) {
          if (agent.entryType === "client") continue;
          console.log(chalk.cyan(`  Agent: ${agent.name}`) + chalk.dim(` (${agent.projectPath})`));
          for (const skill of agent.card.skills) {
            console.log(`    • skill: ${skill.id} — ${skill.description}`);
          }
          console.log();
        }
      } catch {
        console.error(chalk.red("Registry not available. Start it with: agent-communication-bridge registry start"));
        process.exit(1);
      }
    });
}
