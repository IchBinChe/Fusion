// ACP connection layer: spawn → ClientSideConnection → initialize handshake.
//
// U2 establishes the transport and completes the `initialize` handshake with
// integer protocol-version negotiation (KTD2) and a readiness timeout. Session
// driving (`session/new`, `session/prompt`, cancel, load) is U3 — this unit only
// exposes the live `conn` on the returned handle so later units can drive it.
//
// Security posture (KTD6): filesystem client capabilities are advertised ONLY
// when the caller's `advertiseFs` toggle is true — never hardcoded. Teardown is
// registry-SIGKILL-authoritative (KTD4a): `dispose()` force-kills the child via
// the process registry; that kill is the no-orphan guarantee, not a graceful
// round-trip.

import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
} from "@agentclientprotocol/sdk";
import { spawnAgent, captureStderr, forceKill, unregisterProcess } from "./process-manager.js";

/** Default bound for the `initialize` handshake. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/** Thrown when the agent negotiates an integer protocol version we don't support. */
export class IncompatibleProtocolError extends Error {
  readonly code = "incompatible_protocol" as const;
  constructor(
    readonly agentProtocolVersion: number,
    readonly expected: number = PROTOCOL_VERSION,
  ) {
    super(
      `ACP agent negotiated incompatible protocol version ${agentProtocolVersion} (client supports ${expected})`,
    );
    this.name = "IncompatibleProtocolError";
  }
}

/** Thrown when the `initialize` handshake does not complete within the bound. */
export class HandshakeTimeoutError extends Error {
  readonly code = "handshake_timeout" as const;
  constructor(readonly timeoutMs: number) {
    super(`ACP initialize handshake timed out after ${timeoutMs}ms`);
    this.name = "HandshakeTimeoutError";
  }
}

/**
 * Minimal default client handler. Later units (U3/U4/U5/U7) supply the real one
 * that bridges `session/update` into Fusion callbacks and routes permission
 * requests through the action gate. The default cancels every permission request
 * (never auto-allows an untrusted agent) and ignores updates.
 */
export function createDefaultClientHandler(): Client {
  return {
    async sessionUpdate() {
      // no-op until the U4 event bridge is wired
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  };
}

export interface AcpConnection {
  /** Live ACP connection — later units drive session/new, prompt, cancel, load. */
  conn: ClientSideConnection;
  child: ChildProcess;
  agentCapabilities?: unknown;
  /** Auth methods the agent advertised; non-empty means auth is required. */
  authMethods: Array<{ id: string }>;
  /** Current redacted stderr buffer. */
  stderr(): string;
  /** Force-kill the agent via the registry (KTD4a — SIGKILL is authoritative). */
  dispose(): void;
}

export interface ConnectOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientHandler?: Client;
  /** Advertise fs capabilities ONLY where the toggle is true (KTD6). */
  advertiseFs: { read: boolean; write: boolean };
  initializeTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Spawn the agent, establish a `ClientSideConnection` over its stdio, and
 * complete the `initialize` handshake under a timeout.
 *
 * Throws `HandshakeTimeoutError` on timeout, `IncompatibleProtocolError` when
 * the negotiated integer protocol version mismatches — in both cases the
 * subprocess is force-killed before throwing (no orphans, KTD4a). On `initialize`
 * the fs capability flags are gated by `advertiseFs` and never hardcoded (KTD6).
 */
export async function connect(opts: ConnectOptions): Promise<AcpConnection> {
  const timeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  const child = spawnAgent({
    binaryPath: opts.binaryPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
  });
  const stderr = captureStderr(child);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    forceKill(child);
    unregisterProcess(child);
  };

  // If the binary is missing, spawn emits "error" asynchronously. Surface that
  // as a rejection of the handshake rather than an unhandled event-loop error.
  let spawnError: Error | undefined;
  const spawnErrored = new Promise<never>((_resolve, reject) => {
    child.once("error", (err: Error) => {
      spawnError = err;
      reject(err);
    });
  });
  // Avoid an unhandled rejection if the handshake resolves/throws first.
  spawnErrored.catch(() => undefined);

  // output = the agent's stdin; input = the agent's stdout.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );

  const handler = opts.clientHandler ?? createDefaultClientHandler();
  const conn = new ClientSideConnection((_agent: Agent) => handler, stream);

  let initResult: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  try {
    initResult = await Promise.race([
      withTimeout(
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: opts.advertiseFs.read === true,
              writeTextFile: opts.advertiseFs.write === true,
            },
          },
        }),
        timeoutMs,
        () => new HandshakeTimeoutError(timeoutMs),
      ),
      spawnErrored,
    ]);
  } catch (err) {
    dispose();
    if (spawnError && err === spawnError) throw spawnError;
    throw err;
  }

  // Compare the negotiated integer protocol version; do NOT assume the agent
  // errors first (KTD2).
  if (initResult.protocolVersion !== PROTOCOL_VERSION) {
    dispose();
    throw new IncompatibleProtocolError(initResult.protocolVersion);
  }

  const authMethods = Array.isArray(initResult.authMethods)
    ? initResult.authMethods.map((m) => ({ id: m.id }))
    : [];

  return {
    conn,
    child,
    agentCapabilities: initResult.agentCapabilities,
    authMethods,
    stderr,
    dispose,
  };
}
