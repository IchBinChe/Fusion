// @vitest-environment node

/**
 * CLI Agent Executor server-wiring contract (integration bootstrap).
 *
 * Proves that a real `createCliAgentRuntime` bundle (over a temp in-memory DB,
 * PTY mocked at the loadPty seam) satisfies the shapes the dashboard ServerOptions
 * consume:
 *   - `cliAgentHubResolver(projectId, sessionId)` resolves the project's live
 *     TelemetryHub from the runtime bundle.
 *   - `cliSessionTransport` accepts the runtime's manager + store and the
 *     transport-owned ticket/attribution/confirm singletons, and the
 *     cli-sessions router mounts against that dep without error.
 *
 * No real PTY, no network, no port 4040.
 */

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database } from "@fusion/core";
import type { IPty } from "node-pty";
import { createCliAgentRuntime, type BootstrappedCliAgentRuntime } from "@fusion/engine";
import {
  AttachTicketStore,
  CliInputAttributionLog,
  CliConfirmAdvanceRegistry,
} from "../cli-session-transport.js";
import { createCliSessionsRouter } from "../routes/cli-sessions.js";
import { request } from "../test-request.js";

function mockPty(): typeof import("node-pty") {
  return {
    spawn() {
      return {
        pid: 1,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        write() {},
        resize() {},
        pause() {},
        resume() {},
        kill() {},
        clear() {},
      } as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

describe("cli-agent runtime server wiring", () => {
  let runtime: BootstrappedCliAgentRuntime;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fn-cli-wiring-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    runtime = createCliAgentRuntime({
      fusionDir,
      db,
      projectId: "proj-a",
      hookEndpointUrl: "http://127.0.0.1:4040/api/cli-agent/hooks",
      managerOptions: { loadPty: async () => mockPty() },
    });
  });

  afterEach(async () => {
    runtime.dispose();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cliAgentHubResolver resolves the project's hub from the runtime bundle", () => {
    const engines = new Map([["proj-a", { getCliAgentRuntime: () => runtime }]]);
    const cliAgentHubResolver = (projectId: string | undefined, _sessionId: string) => {
      const engine = projectId ? engines.get(projectId) : undefined;
      return engine?.getCliAgentRuntime()?.bundle.hub;
    };

    expect(cliAgentHubResolver("proj-a", "cli-1")).toBe(runtime.bundle.hub);
    expect(cliAgentHubResolver("missing", "cli-1")).toBeUndefined();
    expect(cliAgentHubResolver(undefined, "cli-1")).toBeUndefined();
  });

  it("cliSessionTransport dep is satisfied by the runtime manager + store, and the router mounts", async () => {
    // Seed a session so a transport-backed list route returns it.
    runtime.bundle.store.createSession({
      adapterId: runtime.bundle.registry.ids()[0],
      projectId: "proj-a",
      purpose: "execute",
      taskId: "FN-1",
      worktreePath: "/tmp/wt",
      agentState: "busy",
    });

    const transport = {
      manager: runtime.bundle.manager,
      store: runtime.bundle.store,
      ticketStore: new AttachTicketStore(),
      attributionLog: new CliInputAttributionLog(),
      confirmAdvance: new CliConfirmAdvanceRegistry(),
    };

    const app = express();
    app.use(express.json());
    app.use("/api/cli-sessions", createCliSessionsRouter(transport));

    const res = await request(
      app as unknown as (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
      "GET",
      "/api/cli-sessions?projectId=proj-a",
    );
    expect(res.status).toBe(200);
    const sessions = res.body.sessions as Array<{ taskId?: string }>;
    expect(sessions.some((s) => s.taskId === "FN-1")).toBe(true);
  });
});
