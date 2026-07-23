/*
FNXC:GithubPmIssues 2026-07-24-03:20:
FUSI-012 plugin-local refresh signal: a tiny, dependency-free pub/sub other write-operation
tasks (FUSI-013/014/015 -- issue detail, create/edit/comment/close/reopen, inline
label/assignee/milestone mutation, none of which are built yet) will call `notifyIssuesChanged`
into once their mutations land, so any mounted `IssuesPanel` can re-fetch its current page
instead of forcing a full view reload. Implemented as a module-level `Set` of listeners
(NOT a `window`/DOM CustomEvent) so it works cleanly under jsdom/SSR and is directly testable
without a browser environment. `IssuesPanel` (Step 6/14) is this seam's first consumer.
*/

export type IssueMutationKind = "created" | "updated" | "closed" | "reopened" | "labeled" | "assigned" | "commented";

export interface IssuesChangedDetail {
  /** Canonical "owner/repo" the mutation applies to. */
  repo: string;
  /** The affected issue number, when known. */
  issueNumber?: number;
  kind: IssueMutationKind;
}

type IssuesChangedListener = (detail: IssuesChangedDetail) => void;

const listeners = new Set<IssuesChangedListener>();

/** Subscribe to issue-mutation notifications. Returns an unsubscribe function. */
export function subscribeIssuesChanged(listener: IssuesChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify all current subscribers that an issue mutation occurred. Never throws. */
export function notifyIssuesChanged(detail: IssuesChangedDetail): void {
  for (const listener of listeners) {
    listener(detail);
  }
}
