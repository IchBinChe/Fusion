import { describe, expect, it } from "vitest";

import {
  REVIEW_VERDICT_MARKER,
  buildMergeSystemPrompt,
  buildReviewSystemPrompt,
  parseReviewVerdict,
} from "../merger-ai.js";

describe("merger-ai prompt/verdict re-exports", () => {
  it("fails safe to a blocking reject for empty reviewer output", () => {
    expect(parseReviewVerdict("")).toEqual({
      verdict: "reject",
      reasons: ["reviewer produced no output"],
      severity: "blocking",
    });
  });

  it("fails safe to a blocking reject for garbled reviewer output", () => {
    expect(parseReviewVerdict("looks good, ship it")).toEqual({
      verdict: "reject",
      reasons: [
        `reviewer did not emit a "${REVIEW_VERDICT_MARKER} approve|reject" line`,
      ],
      severity: "blocking",
    });
  });

  it("treats a reject without explicit severity as blocking", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject\n- dropped a conflict hunk`
      )
    ).toEqual({
      verdict: "reject",
      reasons: ["dropped a conflict hunk"],
      severity: "blocking",
    });
  });

  it("honors explicit advisory severity and excludes severity from reasons", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject\nSEVERITY: advisory\n- commit message is vague`
      )
    ).toEqual({
      verdict: "reject",
      reasons: ["commit message is vague"],
      severity: "advisory",
    });
  });

  it("parses the approve line", () => {
    expect(
      parseReviewVerdict(`All reviewed.\n${REVIEW_VERDICT_MARKER} approve`)
    ).toEqual({
      verdict: "approve",
      reasons: [],
    });
  });

  it("extracts inline and bulleted reject reasons", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject: lost generated types\nSEVERITY: blocking\n1. dropped api.ts\n- skipped docs update`
      )
    ).toEqual({
      verdict: "reject",
      reasons: [
        "lost generated types",
        "dropped api.ts",
        "skipped docs update",
      ],
      severity: "blocking",
    });
  });

  it("keeps non-negotiable clean-room and verdict-marker prompt content", () => {
    expect(buildMergeSystemPrompt()).toContain("## AI merge — clean room");
    expect(buildMergeSystemPrompt()).toContain(
      "Finish with exactly ONE new commit"
    );
    expect(buildReviewSystemPrompt()).toContain(REVIEW_VERDICT_MARKER);
    expect(buildReviewSystemPrompt()).toContain("Do NOT edit, stage, commit");
  });
});
