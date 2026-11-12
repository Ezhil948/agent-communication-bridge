import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { isRegistryUp, whichBinary, DEFAULT_REGISTRY_URL } from "../lib/runtime.js";
import { execBinarySync } from "../../utils/process.js";
import { MCP_SERVER_NAME } from "../lib/mcp-config.js";
import { codexSupportsDaemon } from "../../client/codex-daemon-socket.js";
import { loadPromptTemplate, promptTemplatePath, promptTemplateWarnings } from "../../client/prompt-template.js";

function agyPluginList(): string {
  try {
    return execBinarySync("agy", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function versionOf(bin: string): string | null {
  try {
    return execBinarySync(bin, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the agent-communication-bridge environment for Antigravity (agy), Codex, and OpenCode")
    .option("--registry-url <url>", "Registry URL", DEFAULT_REGISTRY_URL)
    .option("--json", "Output checks as JSON")
    .action(async (options) => {
      const checks: Check[] = [];

      const major = Number(process.versions.node.split(".")[0]);
      checks.push({ name: "Node >= 22", ok: major >= 22, detail: `found v${process.versions.node}` });

      const cli = whichBinary("agent-communication-bridge") ?? whichBinary("acb");
      checks.push({
        name: "acb / agent-communication-bridge on PATH",
        ok: cli !== null,
        detail: cli ?? "not found — run `npm install -g .` from the repo, or add the bin dir to PATH",
      });

      const up = await isRegistryUp(options.registryUrl);
      checks.push({
        name: "Registry reachable",
        ok: up,
        detail: up ? options.registryUrl : `down (${options.registryUrl}) — run: acb up`,
      });

      const mcpPath = resolve(".mcp.json");
      let mcpOk = false;
      let mcpDetail = "absent — run: acb init";
      if (existsSync(mcpPath)) {
        try {
          const cfg = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
          };
          const entry = cfg.mcpServers?.[MCP_SERVER_NAME];
          if (entry) {
            mcpOk = true;
            mcpDetail = `present (identity: ${entry.env?.AGENT_BRIDGE_IDENTITY ?? "global"})`;
          } else {
            mcpDetail = "present but missing the agent-communication-bridge entry — run: acb mcp config --write";
          }
        } catch {
          mcpDetail = "present but malformed JSON";
        }
      }
      checks.push({ name: ".mcp.json configured", ok: mcpOk, detail: mcpDetail });

      // Triad Client CLIs: Antigravity (agy), Codex (codex), OpenCode (opencode)
      for (const bin of ["agy", "codex", "opencode"]) {
        const path = whichBinary(bin);
        if (!path || bin !== "codex") {
          checks.push({
            name: `client: ${bin}`,
            ok: path !== null,
            detail: path ?? "not in PATH (optional)",
            optional: true,
          });
          continue;
        }
        const version = versionOf(bin);
        const native = codexSupportsDaemon(version);
        checks.push({
          name: "client: codex (native push)",
          ok: native,
          detail: native
            ? `${version ?? path} — messages arrive as a new turn in the live session`
            : `${version} — needs codex ≥ 0.162 — use: acb codex start`,
          optional: true,
        });
      }

      const inHost = [
        {
          bin: "opencode",
          name: "OpenCode plugin",
          files: [
            resolve(".opencode/plugins/agent-communication-bridge/index.ts"),
            join(homedir(), ".config/opencode/plugins/agent-communication-bridge/index.ts"),
            resolve(".opencode/plugins/agent-bridge.ts"),
            join(homedir(), ".config/opencode/plugins/agent-bridge.ts"),
          ],
          fix: "acb opencode install-plugin",
        },
        {
          bin: "agy",
          name: "agy plugin (MCP + hooks)",
          files: [],
          fix: "acb antigravity install-plugin",
          lookup: () => (/"name"\s*:\s*"(acb|oab)"/.test(agyPluginList()) ? "installed in agy" : undefined),
        },
      ];
      for (const c of inHost as Array<(typeof inHost)[number] & { lookup?: () => string | undefined }>) {
        if (!whichBinary(c.bin)) continue;
        const found = c.lookup ? c.lookup() : c.files.find((f) => existsSync(f));
        const outdated =
          c.bin === "opencode" &&
          found &&
          (found.endsWith("agent-bridge.ts") || !existsSync(join(dirname(found), "tui.ts")));
        checks.push({
          name: `${c.name} (native push)`,
          ok: Boolean(found) && !outdated,
          detail: outdated
            ? `outdated (${found}) — re-run: ${c.fix}`
            : (found ?? `not installed — run: ${c.fix}`),
          optional: true,
        });
      }

      const codexToml = join(homedir(), ".codex", "config.toml");
      if (existsSync(codexToml)) {
        const raw = readFileSync(codexToml, "utf-8");
        const hasSection = raw.includes(`[mcp_servers.${MCP_SERVER_NAME}]`);
        const sectionBody = hasSection
          ? raw.slice(raw.indexOf(`[mcp_servers.${MCP_SERVER_NAME}]`)).split(/\n\[/)[0]
          : "";
        const pinnedProject = /AGENT_BRIDGE_PROJECT\s*=\s*"([^"]+)"/.exec(sectionBody)?.[1];
        checks.push({
          name: "Codex MCP registered",
          ok: hasSection && !pinnedProject,
          detail: !hasSection
            ? `${codexToml} exists but has no [mcp_servers.${MCP_SERVER_NAME}] — run: acb init --client codex`
            : pinnedProject
              ? `pinned to ${pinnedProject} in ${codexToml} (every Codex session will register as that project) — re-run: acb init --client codex -y`
              : codexToml,
          optional: true,
        });
      } else if (whichBinary("codex")) {
        checks.push({
          name: "Codex MCP registered",
          ok: false,
          detail: `${codexToml} not found — run: acb init --client codex`,
          optional: true,
        });
      }

      const tplPath = promptTemplatePath();
      if (tplPath) {
        const tpl = loadPromptTemplate() ?? "";
        const warnings = promptTemplateWarnings(tpl);
        checks.push({
          name: "Prompt template",
          ok: warnings.length === 0,
          detail: warnings.length === 0 ? tplPath : `${tplPath} — ${warnings.join("; ")}`,
          optional: true,
        });
      }

      if (options.json) {
        console.log(JSON.stringify(checks, null, 2));
        const failed = checks.some((c) => !c.ok && !c.optional);
        process.exit(failed ? 1 : 0);
      }

      console.log(chalk.bold("\nagent-communication-bridge doctor\n"));
      for (const c of checks) {
        const icon = c.ok ? chalk.green("✓") : c.optional ? chalk.dim("○") : chalk.red("✗");
        const detail = c.ok ? chalk.dim(c.detail) : c.optional ? chalk.dim(c.detail) : chalk.yellow(c.detail);
        console.log(`  ${icon} ${c.name} — ${detail}`);
      }

      const hardFailures = checks.filter((c) => !c.ok && !c.optional);
      console.log();
      if (hardFailures.length === 0) {
        console.log(chalk.green("All required checks passed.") + chalk.dim("  Run `acb init` in a project to get started.\n"));
      } else {
        console.log(chalk.red(`${hardFailures.length} required check(s) failed — see hints above.\n`));
        process.exit(1);
      }
    });
}
