import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultClientProfileResolver } from "../client/client-profile-resolver.js";
import {
  deliverViaHostInboxSocket,
  hostInboxSocketPath,
  listenHostInbox,
  parentHostInboxSocket,
} from "../client/host-inbox-socket.js";

// Sockets live under a temp XDG_RUNTIME_DIR, never the real one.
let runtime: string;
let env: NodeJS.ProcessEnv;
let close: (() => void) | null = null;

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "oab-rt-"));
  env = { XDG_RUNTIME_DIR: runtime };
});

afterEach(() => {
  close?.();
  close = null;
  rmSync(runtime, { recursive: true, force: true });
});

describe("host inbox socket", () => {
  it("turns a frame written by the adapter into one message for the host", async () => {
    const received: string[] = [];
    close = await listenHostInbox(4242, (c) => received.push(c), env);
    const ok = await deliverViaHostInboxSocket("hello opencode", { socketPath: hostInboxSocketPath(4242, env) });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["hello opencode"]);
  });

  it("starts one turn when two adapters (or a sync replay) write the same message", async () => {
    const received: string[] = [];
    close = await listenHostInbox(4244, (c) => received.push(c), env);
    const socketPath = hostInboxSocketPath(4244, env);
    await deliverViaHostInboxSocket("same", { socketPath, id: "msg-1" });
    await deliverViaHostInboxSocket("same", { socketPath, id: "msg-1" });
    await deliverViaHostInboxSocket("other", { socketPath, id: "msg-2" });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["same", "other"]);
  });

  it("writes only the user message frame to the host inbox socket", async () => {
    const lines: string[] = [];
    close = await listenHostInbox(4243, () => {}, env);
    close();
    const { createServer } = await import("node:net");
    const path = hostInboxSocketPath(4243, env);
    const server = createServer((c) => c.on("data", (d) => lines.push(String(d))));
    if (process.platform === "win32") {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const addr = server.address() as AddressInfo;
      writeFileSync(path, JSON.stringify({ transport: "tcp", host: "127.0.0.1", port: addr.port }));
    } else {
      await new Promise<void>((r) => server.listen(path, () => r()));
    }
    close = () => {
      server.close();
      rmSync(path, { force: true });
    };
    await deliverViaHostInboxSocket("x", { socketPath: path });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.join("")).toContain('"type":"user"');
  });

  it("is private to the user and found from the adapter's parent pid", async () => {
    close = await listenHostInbox(process.ppid, () => {}, env);
    const path = hostInboxSocketPath(process.ppid, env);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    }
    expect(parentHostInboxSocket(env)).toBe(path);
    close();
    close = null;
    expect(parentHostInboxSocket(env)).toBeNull();
  });
});

describe("client profile resolution for Triad clients", () => {
  it("resolves antigravity, codex, and opencode MCP clients to their respective profiles", () => {
    const resolver = new DefaultClientProfileResolver();
    expect(resolver.resolve({ clientName: "antigravity" }).id).toBe("antigravity");
    expect(resolver.resolve({ clientName: "codex-cli" }).id).toBe("codex");
    expect(resolver.resolve({ clientName: "opencode" }).id).toBe("opencode");
  });
});
