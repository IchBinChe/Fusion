import { describe, expect, it } from "vitest";
import type { PlanningQuestion } from "@fusion/core";
import { formatInterviewQA, formatResponseForAgent } from "../planning";

const singleSelectQuestion: PlanningQuestion = {
  id: "scope",
  type: "single_select",
  question: "What scope should we plan?",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full launch" },
  ],
};

const multiSelectQuestion: PlanningQuestion = {
  id: "priorities",
  type: "multi_select",
  question: "Which priorities matter?",
  options: [
    { id: "speed", label: "Speed" },
    { id: "quality", label: "Quality" },
  ],
};

describe("planning interview formatter Other answers", () => {
  it("formats Other-only single-select answers for the planning agent and Q&A history", () => {
    const response = { _other: "Run discovery first" };

    expect(formatResponseForAgent(singleSelectQuestion, response)).toContain(
      "Selected: Run discovery first (user's own answer)",
    );
    expect(formatInterviewQA([{ question: singleSelectQuestion, response }])).toContain(
      "A: Run discovery first (user's own answer)",
    );
  });

  it("appends Other text to multi-select option labels for the planning agent and Q&A history", () => {
    const response = { priorities: ["speed"], _other: "Keep humans in review" };

    expect(formatResponseForAgent(multiSelectQuestion, response)).toContain(
      "Selected: Speed, Keep humans in review (user's own answer)",
    );
    expect(formatInterviewQA([{ question: multiSelectQuestion, response }])).toContain(
      "A: Speed, Keep humans in review (user's own answer)",
    );
  });
});
