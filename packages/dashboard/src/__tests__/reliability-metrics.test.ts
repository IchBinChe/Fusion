import { describe, expect, it } from "vitest";

import type { ActivityLogEntry, RunAuditEvent } from "@fusion/core";

import {
  bucketByDay,
  fileScopeInvariantFailuresPerDay,
  inReviewDurationMetrics,
  inReviewFailureRate7d,
  mergeAttemptsPerMergedTask,
  postMergeAuditFailuresPerDay,
  recoverAlreadyMergedReviewTasksRecoveriesPerDay,
  tasksBouncedToInProgressPerDay,
  tasksEnteredInReviewPerDay,
} from "../reliability-metrics";

function moved(timestamp: string, taskId: string, from: string, to: string): ActivityLogEntry {
  return { id: `${taskId}-${timestamp}`, timestamp, type: "task:moved", taskId, details: "moved", metadata: { from, to } };
}

describe("reliability-metrics", () => {
  it("buckets timestamps by UTC day", () => {
    expect(bucketByDay("2026-05-13T23:59:59.000Z")).toBe("2026-05-13");
  });

  it("counts in-review entries and bounces per day", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-11T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-11T11:00:00.000Z", "FN-2", "in-review", "in-progress"),
      moved("2026-05-12T12:00:00.000Z", "FN-3", "todo", "in-review"),
    ];
    const start = Date.parse("2026-05-10T00:00:00.000Z");
    const end = Date.parse("2026-05-13T00:00:00.000Z");

    expect(tasksEnteredInReviewPerDay(activity, start, end)).toEqual({ "2026-05-11": 1, "2026-05-12": 1 });
    expect(tasksBouncedToInProgressPerDay(activity, start, end)).toEqual({ "2026-05-11": 1 });
  });

  it("returns no-audit-coverage for audit-gap metrics", () => {
    const events: RunAuditEvent[] = [];
    const start = Date.parse("2026-05-10T00:00:00.000Z");
    const end = Date.parse("2026-05-13T00:00:00.000Z");

    expect(postMergeAuditFailuresPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
    expect(fileScopeInvariantFailuresPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
    expect(recoverAlreadyMergedReviewTasksRecoveriesPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
  });

  it("computes in-review duration percentiles", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-10T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-10T11:00:00.000Z", "FN-1", "in-review", "done"),
      moved("2026-05-10T12:00:00.000Z", "FN-2", "todo", "in-review"),
      moved("2026-05-10T14:00:00.000Z", "FN-2", "in-review", "done"),
      moved("2026-05-10T15:00:00.000Z", "FN-3", "todo", "in-review"),
      moved("2026-05-10T18:00:00.000Z", "FN-3", "in-review", "done"),
    ];

    const metric = inReviewDurationMetrics(
      activity,
      Date.parse("2026-05-10T00:00:00.000Z"),
      Date.parse("2026-05-11T00:00:00.000Z"),
    );

    expect(metric.sampleCount).toBe(3);
    expect(metric.p50Ms).toBe(2 * 60 * 60 * 1000);
    expect(metric.p95Ms).toBe(3 * 60 * 60 * 1000);
  });

  it("returns insufficient-samples when too few review exits", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-10T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-10T11:00:00.000Z", "FN-1", "in-review", "done"),
    ];

    expect(
      inReviewDurationMetrics(activity, Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z")),
    ).toEqual({ p50Ms: null, p95Ms: null, sampleCount: 1, reason: "insufficient-samples" });
  });

  it("computes merge attempts per merged task", () => {
    const events: RunAuditEvent[] = [
      {
        id: "1",
        timestamp: "2026-05-10T10:00:00.000Z",
        taskId: "FN-1",
        agentId: "a",
        runId: "r1",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-1",
        metadata: { phase: "merge-attempt-1" },
      },
      {
        id: "2",
        timestamp: "2026-05-10T10:01:00.000Z",
        taskId: "FN-1",
        agentId: "a",
        runId: "r1",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-1",
        metadata: { phase: "merge-attempt-2" },
      },
      {
        id: "3",
        timestamp: "2026-05-10T10:00:00.000Z",
        taskId: "FN-2",
        agentId: "a",
        runId: "r2",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-2",
        metadata: { phase: "merge-attempt-1" },
      },
    ];

    const activity: ActivityLogEntry[] = [
      { id: "m1", timestamp: "2026-05-10T12:00:00.000Z", type: "task:merged", taskId: "FN-1", details: "merged" },
      { id: "m2", timestamp: "2026-05-10T13:00:00.000Z", type: "task:merged", taskId: "FN-2", details: "merged" },
    ];

    const metric = mergeAttemptsPerMergedTask(events, activity, Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z"));
    expect(metric.mean).toBe(1.5);
    expect(metric.max).toBe(2);
    expect(metric.histogram).toEqual({ "1": 1, "2": 1 });
  });

  it("returns no-audit-coverage when merge attempts cannot be inferred", () => {
    const metric = mergeAttemptsPerMergedTask([], [], Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z"));
    expect(metric).toEqual({ mean: null, max: null, histogram: {}, reason: "no-audit-coverage" });
  });

  it("computes in-review failure rate and null reason", () => {
    const endMs = Date.parse("2026-05-13T00:00:00.000Z");
    expect(inReviewFailureRate7d({ "2026-05-13": 10 }, { "2026-05-13": 2 }, endMs)).toEqual({ value: 0.2 });
    expect(inReviewFailureRate7d({}, {}, endMs)).toEqual({ value: null, reason: "no-in-review-entries" });
  });
});
