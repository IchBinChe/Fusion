import type { ReportActionType } from "@fusion/core";

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json();
}

export function reportDraft(input: { actionType: ReportActionType; userPrompt: string; contextRefs?: { taskId?: string; agentId?: string } }) { return post("/api/report/draft", input); }
export function reportFile(input: { actionType: ReportActionType; report: unknown; endorseIssueNumber?: number; endorseDiscussionId?: string }) { return post("/api/report/file", input); }
export function reportHelp(question: string) { return post("/api/report/help", { question }); }
