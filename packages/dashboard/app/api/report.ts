import type { ReportActionType } from "@fusion/core";

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json();
}

export interface ReportContextInput { actionType: ReportActionType; userPrompt: string; contextRefs?: { taskId?: string; agentId?: string }; activityTrace?: string[]; screenshotArtifactId?: string; }
export function reportDraft(input: ReportContextInput) { return post("/api/report/draft", input); }
export function reportFile(input: { actionType: ReportActionType; report: unknown; endorseIssueNumber?: number; endorseDiscussionId?: string; endorseRoadmapIssueNumber?: number; activityTrace?: string[]; screenshotArtifactId?: string }) { return post("/api/report/file", input); }
export function reportHelp(question: string) { return post("/api/report/help", { question }); }

/** Upload is intentionally multipart: screenshot bytes never join JSON report text. */
export async function reportAttachment(screenshot: Blob): Promise<{ artifactId: string }> {
  const form = new FormData(); form.append("screenshot", screenshot, "report-screenshot.png");
  const response = await fetch("/api/report/attachment", { method: "POST", body: form });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json() as Promise<{ artifactId: string }>;
}
