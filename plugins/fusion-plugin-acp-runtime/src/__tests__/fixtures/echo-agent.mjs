#!/usr/bin/env node
// Minimal runnable ACP *agent* fixture for U2 handshake tests.
//
// Modeled on the SDK's dist/examples/agent.js. For an AGENT, ndJsonStream's
// output is process.stdout and its input is process.stdin (the mirror of the
// client side). Later units extend this fixture; U2 only needs a real peer that
// completes `initialize`, opens a session, and runs a trivial prompt turn.
//
// Test knobs (env):
//   ACP_FIXTURE_PROTOCOL_VERSION  — override the protocolVersion returned by
//                                   initialize (e.g. "999" for mismatch tests).
//   ACP_FIXTURE_HANG_INITIALIZE=1 — never respond to initialize (timeout test).
//   ACP_FIXTURE_LEAK_TOKEN=1      — write a fake auth token to stderr (redaction
//                                   test).
//   ACP_FIXTURE_REQUIRE_AUTH=1    — advertise a non-empty authMethods list.

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class EchoAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize(_params) {
    if (process.env.ACP_FIXTURE_LEAK_TOKEN === "1") {
      process.stderr.write(
        "auth failed: Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
      );
    }
    if (process.env.ACP_FIXTURE_HANG_INITIALIZE === "1") {
      // Never resolve — the client's handshake timeout must fire.
      return new Promise(() => {});
    }
    const versionOverride = process.env.ACP_FIXTURE_PROTOCOL_VERSION;
    const protocolVersion =
      versionOverride !== undefined ? Number(versionOverride) : PROTOCOL_VERSION;
    const response = {
      protocolVersion,
      agentCapabilities: { loadSession: false },
    };
    if (process.env.ACP_FIXTURE_REQUIRE_AUTH === "1") {
      response.authMethods = [{ id: "api-key", name: "API Key", description: null }];
    }
    return response;
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(_params) {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.sessions.set(sessionId, {});
    return { sessionId };
  }

  async setSessionMode(_params) {
    return {};
  }

  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo: hello" },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel(_params) {
    // no-op for the trivial turn
  }
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = ndJsonStream(output, input);
new AgentSideConnection((conn) => new EchoAgent(conn), stream);
