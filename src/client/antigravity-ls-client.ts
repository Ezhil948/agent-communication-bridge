import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { pathsEqual } from "../utils/path.js";
import { getParentProcessChain } from "./process-ancestors.js";

const execFileAsync = promisify(execFile);

/**
 * Client for the Antigravity (`agy`) Cascade Language Server.
 *
 * `agy` runs an internal Language Server that listens on two random localhost
 * ports — one HTTP (connect/JSON), one HTTPS (gRPC). Driving the HTTP one with
 * connect/JSON (no auth on localhost) lets us inject a real user turn into the
 * live TUI via `SendUserCascadeMessage` — the only mechanism that makes an idle
 * `agy` process a message without the user typing.
 *
 * This is an UNDOCUMENTED internal RPC surface (Codeium/Windsurf lineage). All
 * coupling to it is intentionally isolated in this file to bound the blast
 * radius if a future `agy` version changes it.
 */

const LS_SERVICE = "exa.language_server_pb.LanguageServerService";
const LOG_DIR = join(homedir(), ".gemini", "antigravity-cli", "log");

/** Extract the most-recent HTTP (connect) port from `agy` CLI log text. The log
 *  prints both the HTTPS/gRPC and HTTP ports; we want the HTTP one. */
export function parseLatestHttpPort(logText: string): number | undefined {
  let port: number | undefined;
  const re = /listening on random port at (\d+) for HTTP(?!S)/g;
  for (const m of logText.matchAll(re)) {
    port = Number(m[1]);
  }
  return port;
}

interface TrajectorySummary {
  lastModifiedTime?: string;
  status?: string;
  trajectoryId?: string;
  workspaces?: Array<{ workspaceFolderAbsoluteUri?: string }>;
}
interface CascadeTrajectoriesResponse {
  trajectorySummaries?: Record<string, TrajectorySummary>;
}

/** Pick the most-recently-modified cascadeId whose workspace matches the given
 *  project path. Returns undefined when none match. */
export function pickActiveCascadeId(
  resp: CascadeTrajectoriesResponse,
  projectPath: string,
): string | undefined {
  const summaries = resp.trajectorySummaries ?? {};
  const matches = Object.entries(summaries).filter(([, t]) =>
    (t.workspaces ?? []).some((w) => pathsEqual(w.workspaceFolderAbsoluteUri, projectPath)),
  );
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b[1].lastModifiedTime ?? "").localeCompare(a[1].lastModifiedTime ?? ""));
  return matches[0][0];
}

/** Where agy's language server listens. agy ≥ 1.3 rejects RPCs without the
 *  CSRF token it hands to its sidecars (`x-codeium-csrf-token`). */
export interface LsTarget {
  url: string;
  csrf?: string;
}

/** The language server of the agy process that ran this command (agy hands its
 *  address and token to the commands it runs, hooks included). */
export function lsTargetFromEnv(env: NodeJS.ProcessEnv = process.env): LsTarget | undefined {
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  if (!address) return undefined;
  return { url: address.startsWith("http") ? address : `http://${address}`, csrf: env.ANTIGRAVITY_CSRF_TOKEN };
}

/** An agy session's live conversation and the language server that runs it. */
export interface AgyConversation extends LsTarget {
  cascadeId: string;
  projectPath?: string;
}

/**
 * agy gives MCP servers neither the LS address nor the token, but its hooks get
 * both. A hook leaves them here, keyed by the agy pid, for the MCP adapter (agy's
 * direct child) to find. 0600 in a 0700 directory, like the host inbox sockets.
 */
export function agyConversationPath(agyPid: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "agent-communication-bridge", `agy-${agyPid}.json`);
}

export function writeAgyConversation(agyPid: number, conversation: AgyConversation, env: NodeJS.ProcessEnv = process.env): void {
  const path = agyConversationPath(agyPid, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(conversation), { mode: 0o600 });
  if (process.platform === "win32" && process.ppid && process.ppid !== agyPid) {
    try {
      const ppidPath = agyConversationPath(process.ppid, env);
      writeFileSync(ppidPath, JSON.stringify(conversation), { mode: 0o600 });
    } catch {
      // best-effort
    }
  }
}

export function readAgyConversation(
  agyPid: number,
  env: NodeJS.ProcessEnv = process.env,
  expectedProjectPath?: string,
): AgyConversation | undefined {
  const baseDir = env.XDG_RUNTIME_DIR || tmpdir();
  const subdirs = ["agent-communication-bridge", "open-agent-bridge"];
  const pids = agyPid === process.ppid ? getParentProcessChain(agyPid) : [agyPid];

  let sawExplicitPidFile = false;
  for (const pid of pids) {
    for (const sub of subdirs) {
      const targetPath = join(baseDir, sub, `agy-${pid}.json`);
      if (!existsSync(targetPath)) continue;
      sawExplicitPidFile = true;
      try {
        const c = JSON.parse(readFileSync(targetPath, "utf8")) as AgyConversation;
        if (!c.url || !c.csrf || !c.cascadeId) continue;
        if (expectedProjectPath && c.projectPath && !pathsEqual(c.projectPath, expectedProjectPath)) continue;
        return c;
      } catch {
        // ignore corrupt file
      }
    }
  }

  // Fallback on Windows when PID ancestry couldn't match, strictly scoped to the same projectPath
  // (never fall back when the explicit PID already wrote a record without a CSRF token).
  if (process.platform === "win32" && !sawExplicitPidFile && expectedProjectPath) {
    for (const sub of subdirs) {
      try {
        const dir = join(baseDir, sub);
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
          .filter((f) => f.startsWith("agy-") && f.endsWith(".json"))
          .map((f) => join(dir, f));
        files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        for (const file of files) {
          try {
            const c = JSON.parse(readFileSync(file, "utf8")) as AgyConversation;
            if (c.url && c.csrf && c.cascadeId && c.projectPath && pathsEqual(c.projectPath, expectedProjectPath)) {
              return c;
            }
          } catch {
            // ignore corrupt file
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}

async function rpc(target: number | LsTarget, method: string, body: unknown): Promise<unknown> {
  const { url, csrf } = typeof target === "number" ? { url: `http://127.0.0.1:${target}`, csrf: undefined } : target;
  const res = await fetch(`${url}/${LS_SERVICE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrf ? { "x-codeium-csrf-token": csrf } : {}) },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Verify a port is the LS HTTP endpoint by calling the no-op GetWorkspaceInfos. */
async function isLsHttpPort(port: number): Promise<boolean> {
  try {
    await rpc(port, "GetWorkspaceInfos", {});
    return true;
  } catch {
    return false;
  }
}

/** Find the LS HTTP port: prefer the CLI log, fall back to scanning the agy
 *  process's listening ports. Verifies the candidate actually speaks connect. */
export async function discoverLsHttpPort(): Promise<number | undefined> {
  // 1. From the most-recent CLI log.
  try {
    if (existsSync(LOG_DIR)) {
      const logs = (await readdir(LOG_DIR))
        .filter((f) => f.endsWith(".log"))
        .map((f) => join(LOG_DIR, f));
      // Read each log newest-first by filename (timestamped); first port that
      // actually answers connect wins.
      for (const p of logs.sort().reverse()) {
        const port = parseLatestHttpPort(readFileSync(p, "utf8"));
        if (port && (await isLsHttpPort(port))) return port;
      }
    }
  } catch {
    // fall through to socket scan
  }

  // 2. Fall back to the agy process's listening localhost ports.
  try {
    const ports = new Set<number>();
    if (process.platform === "win32") {
      const [{ stdout: tasksOut }, { stdout: netOut }] = await Promise.all([
        execFileAsync("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }),
        execFileAsync("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }),
      ]);
      const agyPids = new Set<string>();
      for (const line of tasksOut.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (!m) continue;
        const procName = m[1].toLowerCase();
        if (procName.includes("agy") || procName.includes("antigravity") || procName.includes("language_server")) {
          agyPids.add(m[2]);
        }
      }
      for (const line of netOut.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const m = /127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
        if (m && agyPids.has(m[2])) ports.add(Number(m[1]));
      }
    } else {
      const { stdout } = await execFileAsync("ss", ["-tlnp"]);
      for (const line of stdout.split("\n")) {
        if (!line.includes('"agy"')) continue;
        const m = line.match(/127\.0\.0\.1:(\d+)/);
        if (m) ports.add(Number(m[1]));
      }
    }
    for (const port of ports) {
      if (await isLsHttpPort(port)) return port;
    }
  } catch {
    // Port discovery unavailable
  }
  return undefined;
}

/** Resolve the active cascadeId for a project workspace, or undefined. */
export async function getActiveCascadeId(
  target: number | LsTarget,
  projectPath: string,
): Promise<string | undefined> {
  const resp = (await rpc(target, "GetAllCascadeTrajectories", {})) as CascadeTrajectoriesResponse;
  return pickActiveCascadeId(resp, projectPath);
}

interface TrajectoryResponse {
  trajectory?: { steps?: Array<{ userInput?: { userConfig?: unknown; userAgentSpec?: unknown } }> };
}

/** What the user's last message ran with: agy refuses a turn without a plan
 *  model, and reusing the TUI's config keeps the model and agent the user picked.
 *  ponytail: fetches the whole trajectory per delivery; page it if conversations get huge. */
async function lastUserTurnConfig(target: number | LsTarget, cascadeId: string): Promise<Record<string, unknown>> {
  const resp = (await rpc(target, "GetCascadeTrajectory", { cascadeId })) as TrajectoryResponse;
  const steps = resp.trajectory?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const input = steps[i].userInput;
    if (input?.userConfig) return { cascadeConfig: input.userConfig, customAgentSpec: input.userAgentSpec };
  }
  return {};
}

/** Inject a USER message into the live cascade — this triggers a real turn, so
 *  `agy` processes it without the user typing. `messageOrigin` tags the source
 *  (a known enum) so agy treats it as an external/SDK-driven message. Returns
 *  true on HTTP 200. */
export async function sendUserCascadeMessage(
  target: number | LsTarget,
  cascadeId: string,
  text: string,
  opts?: { model?: string; reasoning?: string },
): Promise<boolean> {
  const baseConfig = await lastUserTurnConfig(target, cascadeId);
  if (opts?.model || opts?.reasoning) {
    const cascadeConfig =
      baseConfig.cascadeConfig && typeof baseConfig.cascadeConfig === "object"
        ? structuredClone(baseConfig.cascadeConfig as Record<string, any>)
        : {};
    cascadeConfig.plannerConfig = cascadeConfig.plannerConfig ?? {};
    cascadeConfig.plannerConfig.requestedModel = cascadeConfig.plannerConfig.requestedModel ?? {};
    if (opts.model) {
      cascadeConfig.plannerConfig.requestedModel.model = opts.model;
    }
    if (opts.reasoning) {
      cascadeConfig.plannerConfig.requestedModel.thinkingEffort = opts.reasoning;
    }
    baseConfig.cascadeConfig = cascadeConfig;
  }

  await rpc(target, "SendUserCascadeMessage", {
    cascadeId,
    items: [{ text }],
    ...baseConfig,
    // Enum names from agy 1.3.4 (`exa.cortex_pb`); the old MESSAGE_ORIGIN_* value does not exist.
    messageOrigin: "AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE",
    // Queue behind a running turn instead of being rejected or interrupting it.
    deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
  });
  return true;
}
