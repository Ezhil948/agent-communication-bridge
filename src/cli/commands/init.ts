import { execBinarySync } from "../../utils/process.js";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { ensureRegistry, resolveCliEntry, DEFAULT_REGISTRY_PORT } from "../lib/runtime.js";
import {
  buildMcpServerEntry,
  buildCodexMcpAddArgs,
  writeCodexProjectConfig,
  writeMcpConfig,
  defaultMcpMode,
  MCP_SERVER_NAME,
  type McpConfigMode,
} from "../lib/mcp-config.js";

function collectClient(value: string, prev: string[]): string[] {
  return [...prev, ...value.split(",").map((s) => s.trim()).filter(Boolean)];
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up agent-communication-bridge for Antigravity (agy), Codex, and OpenCode")
    .option("--identity <id>", "Channel namespace (default: global)")
    .option("--client <name>", "Client to set up (antigravity|codex|opencode); repeatable or comma-separated", collectClient, [])
    .option("--project <path>", "Project path (default: cwd)")
    .option("-p, --port <number>", "Registry port", String(DEFAULT_REGISTRY_PORT))
    .option("--mode <mode>", "MCP command mode: linked|local (default: auto)")
    .option("-y, --yes", "Non-interactive: use flags/defaults without prompting")
    .action(async (options) => {
      const projectPath = resolve(options.project ?? process.cwd());
      const port = Number(options.port);
      const interactive = !options.yes && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

      let identity: string = options.identity ?? "global";
      let clients: string[] = (options.client ?? []) as string[];
      const mode: McpConfigMode =
        options.mode === "local" ? "local" : options.mode === "linked" ? "linked" : defaultMcpMode();

      if (interactive) {
        p.intro(chalk.bold("agent-communication-bridge · init"));
        p.log.info(`Project: ${chalk.cyan(projectPath)}`);
        const answers = await p.group(
          {
            identity: () =>
              p.text({
                message: "Channel identity (namespace) — sessions only see peers sharing it",
                placeholder: "global",
                defaultValue: "global",
                initialValue: options.identity ?? "",
              }),
            clients: () =>
              p.multiselect({
                message: "Which Triad clients do you want to set up?",
                options: [
                  { value: "antigravity", label: "Antigravity (agy)" },
                  { value: "codex", label: "OpenAI Codex (codex)" },
                  { value: "opencode", label: "OpenCode (opencode)" },
                ],
                initialValues: clients.length ? clients : ["antigravity", "codex", "opencode"],
                required: true,
              }),
          },
          {
            onCancel: () => {
              p.cancel("Cancelled.");
              process.exit(0);
            },
          },
        );
        identity = (answers.identity as string)?.trim() || "global";
        clients = answers.clients as string[];
      }

      if (clients.length === 0) clients = ["antigravity", "codex", "opencode"];

      const ok = (msg: string) => (interactive ? p.log.success(msg) : console.log(chalk.green("✓") + " " + msg));
      const warn = (msg: string) => (interactive ? p.log.warn(msg) : console.warn(chalk.yellow("⚠") + " " + msg));
      const fail = (msg: string) => (interactive ? p.log.error(msg) : console.error(chalk.red("✗") + " " + msg));

      const entry = buildMcpServerEntry({ projectPath, identity, mode });
      const { merged } = writeMcpConfig(resolve(projectPath, ".mcp.json"), entry);
      ok(`.mcp.json ${merged ? "updated" : "written"} ${chalk.dim(`(mode: ${mode}, identity: ${identity})`)}`);

      try {
        const { started } = await ensureRegistry({ port, cwd: projectPath });
        ok(started ? `Registry started on :${port}` : `Registry already up on :${port}`);
      } catch (err) {
        fail("Could not start registry: " + (err instanceof Error ? err.message : String(err)));
      }

      for (const client of clients) {
        if (client === "codex") {
          try {
            try {
              execBinarySync("codex", ["mcp", "remove", MCP_SERVER_NAME], { stdio: "ignore" });
            } catch {
              // Not registered yet
            }
            execBinarySync("codex", buildCodexMcpAddArgs(entry), { stdio: "inherit" });
            ok(`Codex MCP registered ${chalk.dim("(~/.codex/config.toml)")}`);
          } catch {
            warn(
              `Could not register with Codex — is \`codex\` on PATH? Run manually:\n  codex ${buildCodexMcpAddArgs(entry).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
            );
          }
          if (identity !== "global") {
            const { path, written } = writeCodexProjectConfig(projectPath, entry);
            if (written) ok(`Codex identity ${identity} declared ${chalk.dim(`(${path})`)}`);
            else warn(`${path} already declares ${MCP_SERVER_NAME} — left as is; check its AGENT_BRIDGE_IDENTITY`);
          }
        }
        if (client === "opencode" || client === "antigravity") {
          const args = client === "opencode" ? ["--project", projectPath] : [];
          try {
            execBinarySync(process.execPath, [resolveCliEntry(), client, "install-plugin", ...args], { stdio: "inherit" });
          } catch {
            warn(`Could not auto-configure ${client} — run \`acb ${client} install-plugin --project ${projectPath}\` manually`);
          }
        }
      }

      const nextSteps: string[] = [];
      if (clients.includes("antigravity")) nextSteps.push(`Antigravity →  ${chalk.cyan("agy")}`);
      if (clients.includes("codex")) nextSteps.push(`Codex       →  ${chalk.cyan("codex")}   ${chalk.dim("(or `acb codex start` for headless)")}`);
      if (clients.includes("opencode")) nextSteps.push(`OpenCode    →  ${chalk.cyan("opencode")}`);

      if (interactive) {
        if (nextSteps.length) p.note(nextSteps.join("\n"), "Launch your session");
        p.outro(chalk.green("Ready!"));
      } else if (nextSteps.length) {
        console.log("\nNext steps:\n  " + nextSteps.join("\n  ") + "\n");
      }
    });
}
