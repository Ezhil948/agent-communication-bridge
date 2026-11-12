#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerUpCommand } from "./commands/up.js";
import { registerStartCommand } from "./commands/start.js";
import { registerRegistryCommand } from "./commands/registry.js";
import { registerListCommand } from "./commands/list.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerFindCommand } from "./commands/find.js";
import { registerDelegateCommand } from "./commands/delegate.js";
import { registerBroadcastCommand } from "./commands/broadcast.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerAntigravityCommand } from "./commands/antigravity.js";
import { registerOpenCodeCommand } from "./commands/opencode.js";
import { registerPromptCommand } from "./commands/prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const program = new Command();

program
  .name("agent-communication-bridge")
  .description("Triad agent communication protocol for Antigravity (agy), Codex, and OpenCode — A2A + MCP + WebSocket")
  .version(readVersion());

// Setup & diagnostics
registerInitCommand(program);
registerUpCommand(program);
registerDoctorCommand(program);

// Core & Triad adapters
registerStartCommand(program);
registerRegistryCommand(program);
registerListCommand(program);
registerPruneCommand(program);
registerHealthCommand(program);
registerAskCommand(program);
registerFindCommand(program);
registerDelegateCommand(program);
registerBroadcastCommand(program);
registerMcpCommand(program);
registerAntigravityCommand(program);
registerCodexCommand(program);
registerOpenCodeCommand(program);
registerPromptCommand(program);

program.parse(process.argv);
