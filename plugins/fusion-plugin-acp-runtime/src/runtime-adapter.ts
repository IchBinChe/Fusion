// AgentRuntime adapter for the ACP runtime.
//
// U3 implements the real session lifecycle: createSession spawns + handshakes
// (U2 connect()) then opens a `session/new`; promptWithFallback drives one
// prompt turn to its terminal stopReason; dispose tears down the connection
// (KTD4a — registry SIGKILL is authoritative). The `session/update` event
// bridge (U4) and the permission gate (U5) are wired in later units; for U3 the
// default client handler from U2 is used and a turn still resolves with a
// stopReason.

import { resolveCliSettings, type AcpCliSettings } from "./cli-spawn.js";
import {
  connect,
  newAcpSession,
  promptAcpSession,
  cancelAcpSession,
  createBridgingClientHandler,
} from "./provider.js";
import { buildSpawnEnv } from "./process-manager.js";
import { buildPromptBlocks } from "./prompt-builder.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  AcpSession,
} from "./types.js";

/**
 * Retained for back-compat: earlier units' tests imported this marker. The real
 * adapter no longer throws it; it remains exported so external references resolve.
 */
export const ACP_NOT_IMPLEMENTED = "acp_not_implemented";

export class AcpRuntimeAdapter implements AgentRuntime {
  readonly id = "acp";
  readonly name = "ACP Runtime";
  private readonly settings: AcpCliSettings;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const model = this.settings.model ?? options.defaultModelId ?? "acp";

    // Bridge streamed `session/update` notifications onto the engine callbacks
    // (U4) so ACP agents render like existing runtimes.
    const callbacks = {
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
    };

    // Build the bridging client handler with the per-run permission gate (U5):
    // its `requestPermission` classifies each call per-category against the live
    // gate (KTD3a) and selects `allow_once` only (S2). `cancelPending` drains
    // in-flight permission requests on teardown so the agent never deadlocks.
    // fs client capabilities (U7) are gated by settings — reads opt-in, writes
    // default OFF (KTD6) — and confined to the task cwd by the path jail. The
    // same toggles drive the advertised `fs` capability in connect() below, so
    // advertisement and registered handlers stay consistent.
    const { handler: clientHandler, cancelPending } = createBridgingClientHandler(
      callbacks,
      options.actionGateContext,
      {
        cwd: options.cwd,
        allowRead: this.settings.fsRead,
        allowWrite: this.settings.fsWrite,
      },
    );

    // Spawn + initialize (U2). fs capabilities are advertised only where the
    // resolved settings enable them (KTD6); the subprocess env is built from the
    // allow-list, never inherited process.env (KTD6b).
    const connection = await connect({
      binaryPath: this.settings.binaryPath,
      args: this.settings.args,
      cwd: options.cwd,
      env: buildSpawnEnv(this.settings.envAllowList),
      advertiseFs: { read: this.settings.fsRead, write: this.settings.fsWrite },
      clientHandler,
    });

    // Open the ACP session over the task worktree (empty mcpServers — KTD5).
    let sessionId: string;
    try {
      const opened = await newAcpSession(connection, { cwd: options.cwd });
      sessionId = opened.sessionId;
    } catch (err) {
      // Don't leak the subprocess if session/new fails after a good handshake.
      connection.dispose();
      throw err;
    }

    let disposed = false;
    const session: AcpSession = {
      model,
      systemPrompt: options.systemPrompt,
      sessionId,
      cwd: options.cwd,
      lastModelDescription: `acp/${model}`,
      callbacks,
      // Persist the per-run gate (KTD3) so U5/U7 can reach the live action gate.
      gate: options.actionGateContext,
      connection,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Drain in-flight permission requests BEFORE the registry kill so a
        // blocked agent is released (KTD4a — the SIGKILL is still authoritative).
        cancelPending();
        connection.dispose();
      },
    };

    return { session };
  }

  async promptWithFallback(
    session: AgentSession,
    prompt: string,
    _options?: unknown,
  ): Promise<void> {
    const acp = session as AcpSession;
    if (!acp.connection) {
      throw new Error("ACP session has no live connection (createSession not completed)");
    }
    const blocks = buildPromptBlocks(prompt);
    // Resolve when the SDK prompt promise resolves — it already drains all
    // session/update notifications for the turn before reporting the stopReason.
    // The bridging client handler installed at createSession (U4) has already
    // surfaced streamed text/thinking/tool updates onto session.callbacks.
    await promptAcpSession(acp.connection, acp.sessionId, blocks);
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || "acp";
  }

  async dispose(session: AgentSession): Promise<void> {
    // KTD4a teardown: best-effort cancel of any in-flight turn, then force the
    // connection down. The process-registry SIGKILL is the authoritative
    // no-orphan guarantee, not the cancel round-trip. Idempotent.
    const acp = session as AcpSession;
    if (acp.connection && acp.sessionId) {
      await cancelAcpSession(acp.connection, acp.sessionId);
    }
    session.dispose();
  }
}
