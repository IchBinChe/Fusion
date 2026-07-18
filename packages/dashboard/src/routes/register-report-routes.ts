import { ApiError } from "../api-error.js";
import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { requireAsyncLayer } from "../require-async-layer.js";
import { runReportPipeline, type ReportInput, type StructuredReport } from "../report-pipeline.js";
import { scrubReportPayload } from "../report-scrub.js";
import { selfCheckHelp } from "../report-help-selfcheck.js";
import type { ApiRouteRegistrar } from "./types.js";

const ACTION_TYPES = new Set(["bug", "feedback", "idea", "help"]);

async function gatherReportContext(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {
    reportMode: settings.reportMode,
    githubAuthMode: settings.githubAuthMode,
    taskId: input.contextRefs?.taskId,
    agentId: input.contextRefs?.agentId,
  };
  if (!input.contextRefs?.taskId) return context;

  const task = await store.getTask(input.contextRefs.taskId).catch(() => null);
  if (!task) return context;
  const logs = await store.getAgentLogs(task.id, { limit: 10 }).catch(() => []);
  context.task = { id: task.id, title: task.title, column: task.column, status: task.status, error: task.error, assignedAgentId: task.assignedAgentId };
  context.recentLogs = logs.map((entry) => entry.text ?? JSON.stringify(entry)).slice(-10);
  return context;
}

async function selfCheckHelpBeforePipeline(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput) {
  if (input.actionType !== "help") return undefined;
  const layer = requireAsyncLayer(store, "Help self-check");
  return selfCheckHelp(input.userPrompt, (query) => queryKnowledgePagesAsync(layer, { query, limit: 1 }));
}

function parseInput(body: unknown): ReportInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const actionType = typeof value.actionType === "string" ? value.actionType : "";
  const userPrompt = typeof value.userPrompt === "string" ? value.userPrompt : "";
  if (!ACTION_TYPES.has(actionType) || !userPrompt.trim()) throw new ApiError(400, "A report type and description are required.");
  return { actionType: actionType as ReportInput["actionType"], userPrompt, contextRefs: typeof value.contextRefs === "object" && value.contextRefs ? value.contextRefs as ReportInput["contextRefs"] : undefined };
}

/**
 * FNXC:ReportPipeline 2026-07-16-12:00:
 * All report routes inherit dashboard auth and resolve a scoped store. The file
 * route treats edited drafts as untrusted and re-scrubs server-side immediately
 * before the pipeline may call GitHub.
 */
export const registerReportRoutes: ApiRouteRegistrar = ({ router, getScopedStore, rethrowAsApiError }) => {
  router.post("/report/draft", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const scopes = await store.getSettingsByScopeFast();
      const input = parseInput(req.body);
      const help = await selfCheckHelpBeforePipeline(store, input);
      if (help?.answered) {
        res.json({ kind: "help", answer: help.answer });
        return;
      }
      const result = await runReportPipeline(input, {
        projectSettings: scopes.project,
        globalSettings: scopes.global,
        scrubContext: { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() },
        gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>),
      });
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to prepare report draft");
    }
  });

  router.post("/report/file", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const scopes = await store.getSettingsByScopeFast();
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const untrusted = scrubReportPayload((raw.report ?? raw) as StructuredReport, { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() });
      const input = parseInput({
        actionType: raw.actionType ?? (untrusted.context as Record<string, unknown> | undefined)?.actionType ?? "bug",
        userPrompt: untrusted.userPrompt ?? untrusted.summary,
        contextRefs: (untrusted.context as Record<string, unknown> | undefined) && {
          taskId: typeof (untrusted.context as Record<string, unknown>).taskId === "string" ? (untrusted.context as Record<string, unknown>).taskId : undefined,
          agentId: typeof (untrusted.context as Record<string, unknown>).agentId === "string" ? (untrusted.context as Record<string, unknown>).agentId : undefined,
        },
      });
      const endorseIssueNumber = typeof raw.endorseIssueNumber === "number" ? raw.endorseIssueNumber : undefined;
      const endorseDiscussionId = typeof raw.endorseDiscussionId === "string" ? raw.endorseDiscussionId : undefined;
      const help = await selfCheckHelpBeforePipeline(store, input);
      if (help?.answered) {
        res.json({ kind: "help", answer: help.answer });
        return;
      }
      const result = await runReportPipeline(input, {
        projectSettings: scopes.project,
        globalSettings: scopes.global,
        scrubContext: { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() },
        gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>),
      }, { file: true, endorseIssueNumber, endorseDiscussionId, report: untrusted });
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to file report");
    }
  });

  router.post("/report/help", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const question = typeof req.body?.question === "string" ? req.body.question : "";
      const layer = requireAsyncLayer(store, "Help self-check");
      const result = await selfCheckHelp(question, (query) => queryKnowledgePagesAsync(layer, { query, limit: 1 }));
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to self-check help question");
    }
  });
};
