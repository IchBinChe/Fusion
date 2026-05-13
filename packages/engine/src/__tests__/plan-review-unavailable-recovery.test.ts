import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string, options?: any) => {
    if (options == null) await session.prompt(prompt);
    else await session.prompt(prompt, options);
  }),
}));

vi.mock("../agent-session-helpers.js", () => ({
  createResolvedAgentSession: vi.fn(),
  extractRuntimeHint: vi.fn().mockReturnValue(undefined),
}));

import { reviewStep } from "../reviewer.js";
import { createResolvedAgentSession } from "../agent-session-helpers.js";

const mockedCreateResolvedAgentSession = vi.mocked(createResolvedAgentSession);

function buildSession(reviewText: string) {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockImplementation((cb: any) => {
        cb({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: reviewText },
        });
      }),
      dispose: vi.fn(),
    },
  } as any;
}

describe("FN-4068 baseline — plan review UNAVAILABLE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns UNAVAILABLE without recovery log when verdict is not parseable", async () => {
    mockedCreateResolvedAgentSession.mockResolvedValue(buildSession("Reviewer output without verdict heading."));

    const store = {
      getSettings: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await reviewStep(
      "/tmp/worktree",
      "FN-4092",
      2,
      "Reproduce stall",
      "plan",
      "# prompt",
      undefined,
      { store, taskId: "FN-4092" },
    );

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.review).toContain("without verdict");
    expect(mockedCreateResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-4092",
      expect.stringContaining("retry with fallback model"),
    );
  });
});
