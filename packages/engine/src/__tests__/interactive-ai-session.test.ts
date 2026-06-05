import { describe, expect, it, vi } from "vitest";
import type { PlanningQuestion, PlanningResponse } from "@fusion/core";
import {
  createInteractiveAiSessionWith,
  runCliAgentPlanning,
  type InteractiveAgentResult,
  type InteractiveAgentSession,
} from "../interactive-ai-session.js";
import type {
  OneShotResult,
  RunOneShotOptions,
} from "../cli-agent/one-shot-session.js";

describe("runCliAgentPlanning (U9 one-shot planning seam)", () => {
  const baseOpts = {
    manager: {} as RunOneShotOptions["manager"],
    adapterId: "claude-code",
    projectId: "p",
    prompt: "plan it",
    cwd: "/tmp",
  };

  it("maps one-shot output to the SAME PlanningResponse shape a model run produces", async () => {
    let seenPurpose: string | undefined;
    const fakeRun = async (opts: RunOneShotOptions): Promise<OneShotResult> => {
      seenPurpose = opts.purpose;
      const summary = {
        title: "Do X",
        description: "Plan to do X",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["X"],
      };
      return {
        ok: true,
        sessionId: "s1",
        parsed: {},
        text: JSON.stringify({ type: "complete", data: summary }),
        rawOutput: "",
      };
    };
    const resp: PlanningResponse = await runCliAgentPlanning(baseOpts, fakeRun as never);
    expect(seenPurpose).toBe("planning");
    expect(resp.type).toBe("complete");
    if (resp.type === "complete") expect(resp.data.title).toBe("Do X");
  });

  it("throws on a failed one-shot (never returns a fabricated plan)", async () => {
    const fakeRun = async (): Promise<OneShotResult> => ({
      ok: false,
      reason: "unparseable",
      sessionId: "s1",
      exitCode: 0,
      stderr: "",
      message: "no result",
    });
    await expect(runCliAgentPlanning(baseOpts, fakeRun as never)).rejects.toThrow(/planning/i);
  });
});

/**
 * A scripted fake agent: each `prompt()` advances through a queue of canned
 * assistant responses, which are exposed via `state.messages` exactly like the
 * real one-shot agent. This deterministically drives the seam's turn loop
 * without a live model (the accepted integration approach per the plan).
 */
function makeScriptedAgent(responses: string[]): {
  session: InteractiveAgentSession;
  disposed: () => boolean;
  promptCalls: () => string[];
} {
  let index = 0;
  let wasDisposed = false;
  const prompts: string[] = [];
  const messages: InteractiveAgentSession["state"]["messages"] = [];

  const session: InteractiveAgentSession = {
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      const reply = responses[index] ?? responses[responses.length - 1];
      index++;
      messages.push({ role: "assistant", content: reply });
    }),
    state: { messages },
    dispose: vi.fn(() => {
      wasDisposed = true;
    }),
  };

  return { session, disposed: () => wasDisposed, promptCalls: () => prompts };
}

function factoryFor(agent: InteractiveAgentSession): () => Promise<InteractiveAgentResult> {
  return async () => ({ session: agent, sessionFile: "/tmp/fake-session.json" });
}

const q = (data: PlanningQuestion): string => JSON.stringify({ type: "question", data } satisfies PlanningResponse);
const complete = (data: unknown): string => JSON.stringify({ type: "complete", data });

describe("interactive-ai-session seam", () => {
  it("round-trips question → answer → complete (happy path)", async () => {
    const question: PlanningQuestion = {
      id: "q1",
      type: "text",
      question: "What is the goal?",
    };
    const scripted = makeScriptedAgent([
      q(question),
      complete({ title: "Done", summary: "ok" }),
    ]);

    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "emit json protocol",
    });

    await session.prompt("start");
    const ev1 = await session.nextEvent();
    expect(ev1.type).toBe("question");
    expect(ev1.type === "question" && ev1.data.id).toBe("q1");

    await session.answer("q1", "ship the thing");
    const ev2 = await session.nextEvent();
    expect(ev2.type).toBe("complete");
    expect(ev2.type === "complete" && ev2.data).toEqual({ title: "Done", summary: "ok" });

    // nextEvent stays terminal after complete.
    expect((await session.nextEvent()).type).toBe("complete");

    session.dispose();
    expect(scripted.disposed()).toBe(true);
  });

  it.each([
    ["text", { id: "t", type: "text", question: "Free text?" } as PlanningQuestion, "a free answer"],
    [
      "single_select",
      {
        id: "s",
        type: "single_select",
        question: "Pick one",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      } as PlanningQuestion,
      "a",
    ],
    [
      "multi_select",
      {
        id: "m",
        type: "multi_select",
        question: "Pick many",
        options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }],
      } as PlanningQuestion,
      ["x", "y"],
    ],
    ["confirm", { id: "c", type: "confirm", question: "Sure?" } as PlanningQuestion, true],
  ])("round-trips %s question type", async (_name, question, answer) => {
    const scripted = makeScriptedAgent([q(question), complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("question");
    expect(ev.type === "question" && ev.data.type).toBe(question.type);

    await session.answer(question.id, answer);
    const done = await session.nextEvent();
    expect(done.type).toBe("complete");

    // The structured answer is forwarded to the agent as JSON.
    const lastPrompt = scripted.promptCalls().at(-1)!;
    expect(JSON.parse(lastPrompt)).toMatchObject({ type: "answer", questionId: question.id, response: answer });
  });

  it("retries once on unparseable output then surfaces an error event (no hang)", async () => {
    // First turn: garbage. Reformat retry: still garbage. → error.
    const scripted = makeScriptedAgent(["not json at all", "still not json"]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toMatch(/parse/i);

    // The reformat-retry prompt was actually sent (2 prompts: initial + retry).
    expect(scripted.promptCalls().length).toBe(2);

    // Terminal: nextEvent keeps returning the error, never hangs.
    expect((await session.nextEvent()).type).toBe("error");
  });

  it("recovers when the reformat retry produces valid JSON", async () => {
    const question: PlanningQuestion = { id: "q1", type: "text", question: "?" };
    const scripted = makeScriptedAgent(["garbage", q(question)]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("question");
  });

  it("surfaces agent prompt errors as an error event without throwing", async () => {
    const throwing: InteractiveAgentSession = {
      prompt: vi.fn(async () => {
        throw new Error("transport exploded");
      }),
      state: { messages: [] },
      dispose: vi.fn(),
    };
    const { session } = await createInteractiveAiSessionWith(factoryFor(throwing), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await expect(session.prompt("start")).resolves.toBeUndefined();
    const ev = await session.nextEvent();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toMatch(/transport exploded/);
  });

  it("ignores answer() when not awaiting input", async () => {
    const scripted = makeScriptedAgent([complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    expect((await session.nextEvent()).type).toBe("complete");

    // answer() after terminal is a no-op; nextEvent stays complete.
    await session.answer("whatever", "x");
    expect((await session.nextEvent()).type).toBe("complete");
  });
});
