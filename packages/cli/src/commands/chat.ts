import { AgentStore } from "@fusion/core";
import type { Message } from "@fusion/core";
import { createMessageStore, formatParticipant, formatTime, CLI_USER_ID } from "./message.js";
import { resolveAgentStoreBase } from "../project-context.js";
import { createInterface } from "node:readline/promises";

const MAX_MESSAGE_LENGTH = 8192;
const DEFAULT_POLL_MS = 1000;
const HISTORY_LIMIT = 20;

/**
 * FNXC:CliChatConversation 2026-07-20-12:00:
 * CLI chats use MessageStore's project-scoped mailbox transport, so the stable
 * CLI-user/agent pair is sufficient to resume a named thread within a project.
 */
export function buildCliChatConversationId(agentId: string, override?: string): string {
  return override ?? `cli-chat:${CLI_USER_ID}:${agentId}`;
}

export interface ChatInteractiveOptions {
  project?: string;
  conversationId?: string;
  pollIntervalMs?: number;
  replyTimeoutMs?: number;
  once?: boolean;
  nonInteractive?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export type ChatCliArgs = Pick<ChatInteractiveOptions, "conversationId" | "pollIntervalMs" | "once" | "nonInteractive"> & {
  agentId: string;
  contentArg: string;
};

/** Parse chat-only argv after the `chat` command for dispatch and unit tests. */
export function parseChatCliArgs(args: string[]): ChatCliArgs | { error: string } {
  const usage = "Usage: fn chat <agent-id> [message…] [--once] [--non-interactive] [--poll-ms <n>] [--conversation-id <id>]";
  const agentId = args[0];
  if (!agentId) return { error: usage };

  const pollIdx = args.indexOf("--poll-ms");
  const pollValue = pollIdx === -1 ? undefined : args[pollIdx + 1];
  const pollIntervalMs = pollValue === undefined ? undefined : Number.parseInt(pollValue, 10);
  if (pollIdx !== -1 && (!pollValue || pollValue.startsWith("--") || !Number.isFinite(pollIntervalMs) || (pollIntervalMs ?? 0) <= 0)) {
    return { error: usage };
  }

  let conversationId: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--conversation-id") continue;
    const value = args[index + 1];
    // FNXC:CliChatConversation 2026-07-20-14:30: Every occurrence must have a value. A first valid flag must not hide a later incomplete flag and silently route mail to the wrong thread.
    if (conversationId !== undefined || !value || value.startsWith("--")) {
      return { error: usage };
    }
    conversationId = value;
    index += 1;
  }

  const filteredArgs = args.slice(1).filter((arg, index, values) => {
    if (arg === "--once" || arg === "--non-interactive" || arg === "--poll-ms" || arg === "--conversation-id") return false;
    if (index > 0 && (values[index - 1] === "--poll-ms" || values[index - 1] === "--conversation-id")) return false;
    return true;
  });
  const contentArg = filteredArgs.join(" ").trim();
  return {
    agentId,
    conversationId,
    pollIntervalMs: pollIdx === -1 ? undefined : pollIntervalMs,
    contentArg,
    once: args.includes("--once") || contentArg.length > 0,
    nonInteractive: args.includes("--non-interactive") || contentArg.length > 0,
  };
}

/*
FNXC:PostgresCutover 2026-07-05-12:00:
Borrow the PostgreSQL AsyncDataLayer from the resolved project store so the
chat AgentStore runs in backend mode (the SQLite runtime was removed under
VAL-REMOVAL-005), mirroring agent.ts/extension.ts createAgentStore.
*/
async function createAgentStore(projectName?: string): Promise<{ store: AgentStore; cleanup: () => Promise<void> }> {
  const base = await resolveAgentStoreBase(projectName);
  const store = new AgentStore({ rootDir: `${base.rootDir}/.fusion`, asyncLayer: base.asyncLayer });
  try {
    await store.init();
    return { store, cleanup: base.cleanup };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      store.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await base.cleanup();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "AgentStore initialization and cleanup failed");
  }
}

function parsePollMs(options: ChatInteractiveOptions): number {
  const envValue = process.env.FUSION_CHAT_POLL_MS;
  const envPollMs = envValue ? Number.parseInt(envValue, 10) : Number.NaN;
  const candidate = options.pollIntervalMs ?? (Number.isFinite(envPollMs) ? envPollMs : DEFAULT_POLL_MS);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_POLL_MS;
}

function printMessage(output: NodeJS.WritableStream, message: Message): void {
  const fromLabel = formatParticipant(message.fromId, message.fromType);
  const time = formatTime(message.createdAt);
  output.write(`${fromLabel} — ${time}\n`);
  output.write(`${message.content}\n\n`);
}

function printConversationTail(output: NodeJS.WritableStream, messages: Message[]): void {
  if (messages.length === 0) {
    output.write("\nNo messages yet.\n\n");
    return;
  }

  output.write("\nRecent conversation:\n\n");
  for (const message of messages) {
    printMessage(output, message);
  }
}

/**
 * FNXC:CliChatConversation 2026-07-20-14:30:
 * MessageStore queries are participant-wide, not conversation-scoped. A mailbox
 * message belongs to this CLI thread only when it carries this id or replies to
 * an already-known thread message; unassociated agent mail remains unread.
 */
function collectConversationMessages(messages: Message[], conversationId: string, threadMessageIds = new Set<string>()): Message[] {
  const includedIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (includedIds.has(message.id)) continue;
      const directMatch = message.metadata?.conversationId === conversationId;
      const replyMatch = typeof message.metadata?.replyTo?.messageId === "string"
        && threadMessageIds.has(message.metadata.replyTo.messageId);
      if (!threadMessageIds.has(message.id) && !directMatch && !replyMatch) continue;
      includedIds.add(message.id);
      if (!threadMessageIds.has(message.id)) {
        threadMessageIds.add(message.id);
        changed = true;
      }
    }
  }
  return messages.filter((message) => includedIds.has(message.id));
}

function isConversationReply(message: Message, conversationId: string, threadMessageIds: Set<string>): boolean {
  return collectConversationMessages([message], conversationId, threadMessageIds).length > 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForReply(
  messageStore: Awaited<ReturnType<typeof createMessageStore>>["store"],
  agentId: string,
  printedIds: Set<string>,
  output: NodeJS.WritableStream,
  pollIntervalMs: number,
  timeoutMs: number,
  conversationId: string,
  threadMessageIds: Set<string>,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const inbox = await messageStore.getInbox(CLI_USER_ID, "user", { limit: 50 });
    for (const message of inbox.slice().reverse()) {
      if (message.fromId !== agentId || message.fromType !== "agent") continue;
      if (!isConversationReply(message, conversationId, threadMessageIds)) continue;
      if (printedIds.has(message.id)) continue;
      printedIds.add(message.id);
      printMessage(output, message);
      await messageStore.markAsRead(message.id);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

export async function runChatInteractive(agentId: string, options: ChatInteractiveOptions = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const pollIntervalMs = parsePollMs(options);
  const conversationId = buildCliChatConversationId(agentId, options.conversationId);

  const ownedAgentStore = await createAgentStore(options.project);
  const agentStore = ownedAgentStore.store;
  let messageOwner: Awaited<ReturnType<typeof createMessageStore>> | undefined;
  let commandFailure: unknown;
  try {
    const agent = await agentStore.getAgent(agentId);
    if (!agent) {
      console.error(`Agent ${agentId} not found`);
      return 1;
    }

    messageOwner = await createMessageStore(options.project);
    const messageStore = messageOwner.store;
    const printedIds = new Set<string>();

    const conversation = await messageStore.getConversation(
    { id: CLI_USER_ID, type: "user" },
    { id: agentId, type: "agent" },
  );
    const threadMessageIds = new Set<string>();
    const tail = collectConversationMessages(conversation, conversationId, threadMessageIds).slice(-HISTORY_LIMIT);
    for (const message of tail) printedIds.add(message.id);

    /*
    FNXC:CliChatConversation 2026-07-20-12:00:
    The CLI must name MessageStore inbox delivery honestly: this is a resumable
    mailbox conversation, not a dashboard ChatView session or multi-agent room.
    */
    output.write(`Mailbox conversation with Agent ${agentId} — type /exit or Ctrl-C to quit, /help for commands\n`);
    output.write(`conversation-id: ${conversationId}\n`);
    output.write("Delivery: agent inbox (fn_read_messages). Not a dashboard chat session or multi-agent room.\n");
    output.write("Replies appear when this project's engine is running (fn dashboard or fn serve).\n");
    printConversationTail(output, tail);

    const runOnce = options.once === true;
    if (runOnce) {
      const content = await readSingleMessage(input, output, options.nonInteractive);
      if (!content.trim()) return 0;

      if (content.length > MAX_MESSAGE_LENGTH) {
        console.error(`Message too long; max ${MAX_MESSAGE_LENGTH} chars`);
        return 0;
      }

      const sentMessage = await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content,
        type: "user-to-agent",
        /*
        FNXC:CliChatConversation 2026-07-20-12:00:
        Keep wake-on-message inbox delivery for durable agents, but stamp every
        CLI chat turn so agents can recognize the resumable mailbox thread.
        */
        metadata: { wakeRecipient: true, kind: "cli-chat", conversationId },
      });

      output.write(`you → ${agentId}: ${content}\n`);
      const timeoutMs = options.replyTimeoutMs ?? Math.max(pollIntervalMs * 10, 30_000);
      threadMessageIds.add(sentMessage.id);
      const replied = await waitForReply(messageStore, agentId, printedIds, output, pollIntervalMs, timeoutMs, conversationId, threadMessageIds);
      if (!replied) {
        console.error(`No reply within ${Math.ceil(timeoutMs / 1000)}s`);
      }
      return 0;
    }

    const abortController = new AbortController();
    const poller = (async () => {
      while (!abortController.signal.aborted) {
        const inbox = await messageStore.getInbox(CLI_USER_ID, "user", { limit: 50 });
        for (const message of inbox.slice().reverse()) {
          if (message.fromId !== agentId || message.fromType !== "agent") continue;
          if (!isConversationReply(message, conversationId, threadMessageIds)) continue;
          if (printedIds.has(message.id)) continue;
          printedIds.add(message.id);
          printMessage(output, message);
          await messageStore.markAsRead(message.id);
        }
        await sleep(pollIntervalMs, abortController.signal);
      }
    })().catch(() => undefined);

    const rl = createInterface({ input, output });
    rl.on("close", () => abortController.abort());

    while (true) {
      let line: string;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        output.write(`Commands: /help, /history, /clear, /exit, /quit. Mailbox delivery to the agent inbox; conversation-id: ${conversationId}\n`);
        continue;
      }
      if (line === "/history") {
        const history = collectConversationMessages(await messageStore.getConversation(
          { id: CLI_USER_ID, type: "user" },
          { id: agentId, type: "agent" },
        ), conversationId, threadMessageIds).slice(-HISTORY_LIMIT);
        for (const message of history) printedIds.add(message.id);
        printConversationTail(output, history);
        continue;
      }
      if (line === "/clear") {
        output.write("\x1b[2J\x1b[H");
        continue;
      }
      if (line.length > MAX_MESSAGE_LENGTH) {
        console.error(`Message too long; max ${MAX_MESSAGE_LENGTH} chars`);
        continue;
      }

      const sentMessage = await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content: line,
        type: "user-to-agent",
        /*
        FNXC:CliChatConversation 2026-07-20-12:00:
        REPL sends share the same conversation identity as once-mode sends;
        MessageStore remains the transport rather than masquerading as a room.
        */
        metadata: { wakeRecipient: true, kind: "cli-chat", conversationId },
      });
      threadMessageIds.add(sentMessage.id);
      output.write(`you → ${agentId}: ${line}\n`);
    }

    abortController.abort();
    rl.close();
    await poller;
    return 0;
  } catch (error) {
    commandFailure = error;
    throw error;
  } finally {
    /* FNXC:PostgresCliLifecycle 2026-07-14-22:55: Chat owns three independently-failing resources. Always attempt AgentStore, message database, and borrowed project teardown; report all cleanup failures without discarding an earlier command failure. */
    const cleanupFailures: unknown[] = [];
    try {
      agentStore.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await messageOwner?.db.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await ownedAgentStore.cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      // eslint-disable-next-line no-unsafe-finally -- cleanup must aggregate with, rather than silently lose, the active command failure.
      throw new AggregateError(
        commandFailure === undefined ? cleanupFailures : [commandFailure, ...cleanupFailures],
        "Chat command cleanup failed",
      );
    }
  }
}

async function readSingleMessage(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  nonInteractive?: boolean,
): Promise<string> {
  if (nonInteractive) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8").trimEnd();
  }

  const rl = createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}
