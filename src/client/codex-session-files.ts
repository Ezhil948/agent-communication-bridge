import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CurrentCodexSessionRecord {
  clientAgentId: string;
  clientName: string;
  projectPath: string;
  registeredAt: number;
  sidecarPid?: number;
  tmuxPane?: string;
  tmuxSessionName?: string;
  tmuxWindowName?: string;
  tmuxCurrentCommand?: string;
}

function sessionFilePath(projectPath: string): string {
  return join(projectPath, ".agent-communication-bridge", "current-codex-session.json");
}

function legacySessionFilePath(projectPath: string): string {
  return join(projectPath, ".open-agent-bridge", "current-codex-session.json");
}

export function writeCurrentCodexSession(projectPath: string, record: CurrentCodexSessionRecord): void {
  const path = sessionFilePath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}

export function readCurrentCodexSession(projectPath: string): CurrentCodexSessionRecord | undefined {
  for (const path of [sessionFilePath(projectPath), legacySessionFilePath(projectPath)]) {
    try {
      if (!existsSync(path)) continue;
      return JSON.parse(readFileSync(path, "utf8")) as CurrentCodexSessionRecord;
    } catch {
      // Ignore corrupt session marker and try next
    }
  }
  return undefined;
}

export function clearCurrentCodexSession(projectPath: string, clientAgentId?: string): void {
  for (const path of [sessionFilePath(projectPath), legacySessionFilePath(projectPath)]) {
    if (!existsSync(path)) continue;

    if (!clientAgentId) {
      rmSync(path, { force: true });
      continue;
    }

    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as CurrentCodexSessionRecord;
      if (current?.clientAgentId === clientAgentId) {
        rmSync(path, { force: true });
      }
    } catch {
      // Ignore corrupt session marker
    }
  }
}
