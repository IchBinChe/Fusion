import { describe, expect, it, vi } from "vitest";
import { notifyIssuesChanged, subscribeIssuesChanged, type IssuesChangedDetail } from "../issues-events.js";

describe("github-pm issues-events (FUSI-012 refresh seam)", () => {
  it("delivers the detail payload to a subscriber", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);
    const detail: IssuesChangedDetail = { repo: "acme/widgets", issueNumber: 42, kind: "closed" };

    notifyIssuesChanged(detail);

    expect(listener).toHaveBeenCalledWith(detail);
    unsubscribe();
  });

  it("stops delivery once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);
    unsubscribe();

    notifyIssuesChanged({ repo: "acme/widgets", kind: "created" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies multiple independent subscribers", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubscribeA = subscribeIssuesChanged(listenerA);
    const unsubscribeB = subscribeIssuesChanged(listenerB);

    notifyIssuesChanged({ repo: "acme/widgets", kind: "commented", issueNumber: 7 });

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    unsubscribeA();
    unsubscribeB();
  });

  it("never throws when there are zero subscribers", () => {
    expect(() => notifyIssuesChanged({ repo: "acme/widgets", kind: "updated" })).not.toThrow();
  });
});
