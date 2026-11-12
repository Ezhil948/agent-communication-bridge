import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractWorkspacePathFromArgs,
  extractWorkspacePathFromCommandLine,
  isPluginInstallPath,
  resolveWorkspaceFromAncestors,
  tokenizeCommandLine,
} from "../client/workspace-discovery.js";

describe("isPluginInstallPath", () => {
  it("recognises Antigravity, Claude, Codex, and OpenCode global plugin directories", () => {
    expect(isPluginInstallPath("C:\\Users\\alice\\.gemini\\config\\plugins\\oab")).toBe(true);
    expect(isPluginInstallPath("/home/alice/.gemini/antigravity/config/plugins/agent-communication-bridge")).toBe(true);
    expect(isPluginInstallPath("/home/alice/.claude/plugins/acp")).toBe(true);
    expect(isPluginInstallPath("/home/alice/.codex/plugins/bridge")).toBe(true);
    expect(isPluginInstallPath("/home/alice/.opencode/plugins")).toBe(true);
  });

  it("does not misclassify ordinary workspace paths", () => {
    expect(isPluginInstallPath("C:\\Users\\alice\\OneDrive\\Desktop\\agents bridge")).toBe(false);
    expect(isPluginInstallPath("/workspace/my-plugins-app")).toBe(false);
    expect(isPluginInstallPath("")).toBe(false);
  });
});

describe("tokenizeCommandLine & extractWorkspacePathFromCommandLine", () => {
  it("extracts quoted Windows --add-dir= paths containing spaces without mangling backslashes", () => {
    const cmd =
      'C:\\Users\\alice\\.gemini\\bin\\agy.exe --hub --csrf_token=secret "--add-dir=c:\\Users\\alice\\OneDrive\\Desktop\\agents bridge"';
    expect(tokenizeCommandLine(cmd)).toEqual([
      "C:\\Users\\alice\\.gemini\\bin\\agy.exe",
      "--hub",
      "--csrf_token=secret",
      "--add-dir=c:\\Users\\alice\\OneDrive\\Desktop\\agents bridge",
    ]);
    expect(extractWorkspacePathFromCommandLine(cmd)).toBe("c:\\Users\\alice\\OneDrive\\Desktop\\agents bridge");
  });

  it("extracts separate --add-dir / --project / --folder-uri flags", () => {
    expect(extractWorkspacePathFromArgs(["agy", "--add-dir", "/work/proj-a"])).toBe("/work/proj-a");
    expect(extractWorkspacePathFromCommandLine("node acb.js --project '/work/my repo'")).toBe("/work/my repo");
    const expectedUriTarget =
      process.platform === "win32" ? "C:\\Users\\Alice\\My Project" : "/tmp/My Project";
    const uriFlag =
      process.platform === "win32"
        ? "--folder-uri=file:///C:/Users/Alice/My%20Project"
        : "--folder-uri=file:///tmp/My%20Project";
    expect(extractWorkspacePathFromArgs(["agy", uriFlag])).toBe(expectedUriTarget);
  });

  it("ignores plugin install directories even when passed via flags", () => {
    expect(
      extractWorkspacePathFromCommandLine(
        'agy --add-dir="C:\\Users\\alice\\.gemini\\config\\plugins\\oab"',
      ),
    ).toBeUndefined();
  });
});

describe("resolveWorkspaceFromAncestors", () => {
  let root: string;
  let projA: string;
  let projB: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acb-ws-disc-"));
    projA = join(root, "proj a");
    projB = join(root, "proj-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers the nearest ancestor with an existing workspace flag", async () => {
    const resolved = await resolveWorkspaceFromAncestors({
      ancestors: [
        { pid: 100, ppid: 200, name: "cmd.exe", commandLine: "cmd.exe /c node mcp.js" },
        { pid: 200, ppid: 300, name: "agy.exe", commandLine: `agy.exe "--add-dir=${projA}"` },
        { pid: 300, ppid: 1, name: "ide.exe", commandLine: `ide.exe "--add-dir=${projB}"` },
      ],
    });
    expect(resolved).toBe(projA);
  });

  it("falls back to agy-<pid>.json projectPath when ancestor flags are absent", async () => {
    const resolved = await resolveWorkspaceFromAncestors({
      ancestors: [
        { pid: 101, ppid: 202, name: "cmd.exe", commandLine: "cmd.exe" },
        { pid: 202, ppid: 1, name: "agy.exe", commandLine: "agy.exe --hub" },
      ],
      readAgyProject: (pid) => (pid === 202 ? projB : undefined),
    });
    expect(resolved).toBe(projB);
  });

  it("skips non-existent paths when checkExists is enabled", async () => {
    const missing = join(root, "does-not-exist");
    const resolved = await resolveWorkspaceFromAncestors({
      ancestors: [
        { pid: 200, ppid: 1, name: "agy.exe", commandLine: `agy.exe --add-dir="${missing}"` },
      ],
    });
    expect(resolved).toBeUndefined();
  });
});

