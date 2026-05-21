import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, ChatStore, TaskStore } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as roomCoordination from "../room-coordination.js";

const sessionCapture = vi.hoisted(() => ({
  prompt: "",
  customTools: [] as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>,
}));

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
    runtimeLog: createMockLogger(),
  };
});

vi.mock("../pi.js", () => ({
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

vi.mock("../agent-session-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-session-helpers.js")>("../agent-session-helpers.js");
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async (options: any) => {
      sessionCapture.customTools = options.customTools ?? [];
      return {
        session: {
          prompt: async (prompt: string) => {
            sessionCapture.prompt = prompt;
          },
          dispose: vi.fn(),
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        },
      };
    }),
  };
});

type Harness = {
  rootDir: string;
  globalDir: string;
  taskStore: TaskStore;
  agentStore: AgentStore;
  chatStore: ChatStore;
  agentId: string;
};

async function createHarness(permissionPolicy?: any): Promise<Harness> {
  const rootDir = mkdtempSync(join(tmpdir(), "hb-room-root-"));
  const globalDir = mkdtempSync(join(tmpdir(), "hb-room-global-"));
  const taskStore = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await taskStore.init();
  const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir(), taskStore, inMemoryDb: true });
  const chatStore = new ChatStore(taskStore.getFusionDir(), taskStore.getDatabase());
  const agent = await agentStore.createAgent({
    name: "Room Heartbeat Agent",
    role: "engineer",
    soul: "Surfaces relevant room updates.",
    runtimeConfig: { enabled: true },
    ...(permissionPolicy ? { permissionPolicy } : {}),
  });
  return { rootDir, globalDir, taskStore, agentStore, chatStore, agentId: agent.id };
}

describe("heartbeat room messages", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    sessionCapture.prompt = "";
    sessionCapture.customTools = [];
  });

  afterEach(() => {
    if (harness) {
      rmSync(harness.rootDir, { recursive: true, force: true });
      rmSync(harness.globalDir, { recursive: true, force: true });
      harness = null;
    }
  });

  it("omits room section and tool when no chatStore is configured", async () => {
    harness = await createHarness();
    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).not.toContain("Pending Room Messages:");
    expect(sessionCapture.customTools.map((tool) => tool.name)).not.toContain("fn_post_room_message");
  });

  it("shows only rooms with new messages", async () => {
    harness = await createHarness();
    const staleRoom = harness.chatStore.createRoom({ name: "stale-room", memberAgentIds: [harness.agentId] });
    const freshRoom = harness.chatStore.createRoom({ name: "fresh-room", memberAgentIds: [harness.agentId] });

    harness.chatStore.addRoomMessage(staleRoom.id, { role: "user", content: "too old" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sinceIso = new Date().toISOString();
    await harness.agentStore.saveRun({
      id: "run-prev-fresh",
      agentId: harness.agentId,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      endedAt: sinceIso,
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const freshMessage = harness.chatStore.addRoomMessage(freshRoom.id, { role: "user", content: "needs review" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).toContain("Pending Room Messages:");
    expect(sessionCapture.prompt).toContain(`fresh-room (${freshRoom.id})`);
    expect(sessionCapture.prompt).toContain(freshMessage.id);
    expect(sessionCapture.prompt).not.toContain(`stale-room (${staleRoom.id})`);
  });

  it("excludes messages older than the lookback cutoff", async () => {
    harness = await createHarness();
    const room = harness.chatStore.createRoom({ name: "lookback", memberAgentIds: [harness.agentId] });

    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "old room note" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cutoff = new Date().toISOString();
    await harness.agentStore.saveRun({
      id: "run-prev-lookback",
      agentId: harness.agentId,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      endedAt: cutoff,
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "fresh room note" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).toContain("fresh room note");
    expect(sessionCapture.prompt).not.toContain("old room note");
  });

  it("shows a truncated marker when total surfaced room messages overflow the cap", async () => {
    harness = await createHarness();
    for (let roomIndex = 0; roomIndex < 4; roomIndex += 1) {
      const room = harness.chatStore.createRoom({ name: `overflow-${roomIndex}`, memberAgentIds: [harness.agentId] });
      for (let messageIndex = 0; messageIndex < 10; messageIndex += 1) {
        harness.chatStore.addRoomMessage(room.id, {
          role: "user",
          content: `message ${roomIndex}-${messageIndex}`,
        });
      }
    }

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).toContain("(10 more truncated)");
  });

  it("adds resolved room ambiguity notice and emits resolved audit branch", async () => {
    harness = await createHarness();
    const room = harness.chatStore.createRoom({ name: "ambiguity-resolved", memberAgentIds: [harness.agentId] });

    harness.chatStore.addRoomMessage(room.id, {
      role: "user",
      content: "we should create a follow-up task to capture the secrets-sync regression",
    });
    const deicticMessage = harness.chatStore.addRoomMessage(room.id, { role: "user", content: "Yeah create it" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).toContain("Room Ambiguity Notices:");
    expect(sessionCapture.prompt).toContain("Resolved Referent: capture the secrets-sync regression");
    expect(sessionCapture.prompt).toContain("echo this exact subject in your reply");

    const auditEvents = harness.taskStore.getRunAuditEvents({ runId: run!.id });
    const branchEvent = auditEvents.find((event) => event.mutationType === "room:ambiguity:branch" && event.target === deicticMessage.id);
    expect(branchEvent?.metadata).toMatchObject({
      branch: "resolved",
      candidateCount: 1,
      roomId: room.id,
      agentId: harness.agentId,
    });
  });

  it("adds clarification room ambiguity notice and emits clarification audit branch", async () => {
    harness = await createHarness();
    const room = harness.chatStore.createRoom({ name: "ambiguity-clarify", memberAgentIds: [harness.agentId] });

    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "we should create a task for FN-1234" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "let's add a docs task" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "could we file a flaky-test task" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "/clear" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "done" });
    const deicticMessage = harness.chatStore.addRoomMessage(room.id, { role: "user", content: "Yeah create it" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.prompt).toContain("Room Ambiguity Notices:");
    expect(sessionCapture.prompt).toContain("Do NOT create a task or spawn work");
    expect(sessionCapture.prompt).toContain(`Use reply_to_message_id = ${deicticMessage.id}`);
    expect(sessionCapture.prompt).toContain("FN-1234");
    expect(sessionCapture.prompt).toContain("docs task");

    const auditEvents = harness.taskStore.getRunAuditEvents({ runId: run!.id });
    const branchEvent = auditEvents.find((event) => event.mutationType === "room:ambiguity:branch" && event.target === deicticMessage.id);
    expect(branchEvent?.metadata).toMatchObject({
      branch: "clarification",
      roomId: room.id,
      agentId: harness.agentId,
    });
  });

  it("locks low-confidence contract against duplicate task creation instructions", async () => {
    harness = await createHarness();
    const room = harness.chatStore.createRoom({ name: "ambiguity-contract", memberAgentIds: [harness.agentId] });

    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "we should create a task for FN-1234" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "let's add a docs task" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "could we file a flaky-test task" });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "Yeah create it" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    const postTool = sessionCapture.customTools.find((tool) => tool.name === "fn_post_room_message");
    const createTool = sessionCapture.customTools.find((tool) => tool.name === "fn_task_create");
    expect(postTool).toBeDefined();
    expect(createTool).toBeDefined();

    expect(sessionCapture.prompt).toContain("Do NOT create a task or spawn work");
    expect(sessionCapture.prompt).not.toContain("Resolved Referent:");
  });

  describe("multi-agent room coordination (FN-5425)", () => {
    async function seedMultiAgentRoom(
      localHarness: Harness,
      { peerAgentId = "agent-peer", roomName }: { peerAgentId?: string; roomName: string },
    ): Promise<{ room: ReturnType<ChatStore["createRoom"]>; peerAgentId: string }> {
      const peerAgent = await localHarness.agentStore.createAgent({
        name: peerAgentId,
        role: "executor",
        soul: "Peer room member",
        runtimeConfig: { enabled: true },
      });
      const room = localHarness.chatStore.createRoom({ name: roomName, memberAgentIds: [localHarness.agentId] });
      localHarness.chatStore.addRoomMember(room.id, peerAgent.id);
      return { room, peerAgentId: peerAgent.id };
    }

    it("renders claim branch and emits coordination audit in multi-agent room", async () => {
      harness = await createHarness();
      const { room } = await seedMultiAgentRoom(harness, { roomName: "coord-claim" });
      const userMessage = harness.chatStore.addRoomMessage(room.id, {
        role: "user",
        content: "please file a task for the secrets-sync regression",
      });

      const monitor = new HeartbeatMonitor({
        store: harness.agentStore,
        taskStore: harness.taskStore,
        rootDir: harness.rootDir,
        chatStore: harness.chatStore,
      });

      const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

      expect(sessionCapture.prompt).toContain("Room Coordination Notices:");
      expect(sessionCapture.prompt).toContain("branch: claim");
      expect(sessionCapture.prompt).toContain("Claiming:");
      expect(sessionCapture.prompt).toContain("fn_task_create");
      expect(sessionCapture.prompt).toContain("fn_post_room_message");
      expect(sessionCapture.prompt).toContain("FN-4918");

      const event = harness.taskStore
        .getRunAuditEvents({ runId: run!.id })
        .find((auditEvent) => auditEvent.mutationType === "room:coordination:branch" && auditEvent.target === userMessage.id);
      expect(event?.metadata).toMatchObject({ branch: "claim" });
    });

    it("renders defer branch when peer already claimed", async () => {
      harness = await createHarness();
      const { room, peerAgentId } = await seedMultiAgentRoom(harness, { roomName: "coord-defer-claim" });
      const priorClaim = harness.chatStore.addRoomMessage(room.id, {
        role: "assistant",
        senderAgentId: peerAgentId,
        content: "Claiming: filing task for the secrets-sync regression",
      });
      harness.chatStore.addRoomMessage(room.id, {
        role: "user",
        content: "please file a task for the secrets-sync regression",
      });

      const monitor = new HeartbeatMonitor({
        store: harness.agentStore,
        taskStore: harness.taskStore,
        rootDir: harness.rootDir,
        chatStore: harness.chatStore,
      });

      const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });
      expect(sessionCapture.prompt).toContain("branch: defer-suggested");
      expect(sessionCapture.prompt).toContain(peerAgentId);
      expect(sessionCapture.prompt).toContain("Do NOT call fn_task_create");

      const event = harness.taskStore
        .getRunAuditEvents({ runId: run!.id })
        .find((auditEvent) => auditEvent.mutationType === "room:coordination:branch");
      expect(event?.metadata).toMatchObject({ branch: "defer-suggested", priorClaimMessageId: priorClaim.id });
    });

    it("captures prior task id from peer announcement", async () => {
      harness = await createHarness();
      const { room, peerAgentId } = await seedMultiAgentRoom(harness, { roomName: "coord-defer-task" });
      harness.chatStore.addRoomMessage(room.id, {
        role: "assistant",
        senderAgentId: peerAgentId,
        content: "Filed FN-9042 for the secrets-sync regression",
      });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "please file a task for the secrets-sync regression" });

      const monitor = new HeartbeatMonitor({
        store: harness.agentStore,
        taskStore: harness.taskStore,
        rootDir: harness.rootDir,
        chatStore: harness.chatStore,
      });

      const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });
      expect(sessionCapture.prompt).toContain("FN-9042");
      const event = harness.taskStore.getRunAuditEvents({ runId: run!.id }).find((auditEvent) => auditEvent.mutationType === "room:coordination:branch");
      expect(event?.metadata).toMatchObject({ priorTaskId: "FN-9042" });
    });

    it("does not render coordination notices for single-agent room", async () => {
      harness = await createHarness();
      const room = harness.chatStore.createRoom({ name: "single-agent", memberAgentIds: [harness.agentId] });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "file a task for X" });

      const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir, chatStore: harness.chatStore });
      const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

      expect(sessionCapture.prompt).not.toContain("Room Coordination Notices:");
      expect(harness.taskStore.getRunAuditEvents({ runId: run!.id }).some((event) => event.mutationType === "room:coordination:branch")).toBe(false);
    });

    it("does not render coordination notices for non-task-filing content", async () => {
      harness = await createHarness();
      const { room } = await seedMultiAgentRoom(harness, { roomName: "coord-non-intent" });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "what do you think about the secrets-sync regression?" });

      const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir, chatStore: harness.chatStore });
      const run = await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

      expect(sessionCapture.prompt).not.toContain("Room Coordination Notices:");
      expect(harness.taskStore.getRunAuditEvents({ runId: run!.id }).some((event) => event.mutationType === "room:coordination:branch")).toBe(false);
    });

    it("keeps deictic-only messages in ambiguity layer only", async () => {
      harness = await createHarness();
      const { room } = await seedMultiAgentRoom(harness, { roomName: "coord-deictic-only" });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "we should investigate the secrets-sync regression" });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "yeah, create it" });

      const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir, chatStore: harness.chatStore });
      await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

      expect(sessionCapture.prompt).toContain("Room Ambiguity Notices:");
      expect(sessionCapture.prompt).not.toContain("Room Coordination Notices:");
    });

    it("does not defer to a self-authored prior claim", async () => {
      harness = await createHarness();
      const { room } = await seedMultiAgentRoom(harness, { roomName: "coord-self-claim" });
      harness.chatStore.addRoomMessage(room.id, {
        role: "assistant",
        senderAgentId: harness.agentId,
        content: "Claiming: filing task for the secrets-sync regression",
      });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "please file a task for the secrets-sync regression" });

      const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir, chatStore: harness.chatStore });
      await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

      expect(sessionCapture.prompt).toContain("branch: claim");
      expect(sessionCapture.prompt).not.toContain("branch: defer-suggested");
    });

    it("fails open when coordination helper throws", async () => {
      harness = await createHarness();
      const { room } = await seedMultiAgentRoom(harness, { roomName: "coord-throw" });
      harness.chatStore.addRoomMessage(room.id, { role: "user", content: "please file a task for the secrets-sync regression" });
      const spy = vi.spyOn(roomCoordination, "decideRoomCoordination").mockImplementation(() => {
        throw new Error("boom");
      });

      const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir, chatStore: harness.chatStore });
      await expect(monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any })).resolves.toBeTruthy();
      expect(sessionCapture.prompt).not.toContain("Room Coordination Notices:");

      spy.mockRestore();
    });
  });

  it("registers fn_post_room_message and posts through the real ChatStore under restrictive policy", async () => {
    harness = await createHarness({
      presetId: "approval-required",
      rules: {
        git_write: "require-approval",
        file_write_delete: "require-approval",
        command_execution: "require-approval",
        network_api: "require-approval",
        task_agent_mutation: "require-approval",
      },
    });
    const room = harness.chatStore.createRoom({ name: "reply-room", memberAgentIds: [harness.agentId] });
    harness.chatStore.addRoomMessage(room.id, { role: "user", content: "can you confirm?" });

    const monitor = new HeartbeatMonitor({
      store: harness.agentStore,
      taskStore: harness.taskStore,
      rootDir: harness.rootDir,
      chatStore: harness.chatStore,
    });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    const postTool = sessionCapture.customTools.find((tool) => tool.name === "fn_post_room_message");
    expect(postTool).toBeDefined();

    const result = await postTool!.execute("call-1", {
      roomId: room.id,
      content: "Confirmed.",
      replyToMessageId: "rmsg-parent",
    });

    expect((result as any).isError).not.toBe(true);
    expect((result as any)?.details?.requiresApproval).not.toBe(true);

    const posted = harness.chatStore.getRoomMessages(room.id).find((message) => message.id === (result as any).details.messageId);
    expect(posted).toMatchObject({
      senderAgentId: harness.agentId,
      content: "Confirmed.",
      metadata: { replyToMessageId: "rmsg-parent" },
    });
  });
});
