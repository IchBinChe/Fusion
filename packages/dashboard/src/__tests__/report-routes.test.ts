import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../knowledge-index.js", () => ({
  queryKnowledgePagesAsync: vi.fn(),
}));
vi.mock("../require-async-layer.js", () => ({
  requireAsyncLayer: vi.fn(() => ({})),
}));
vi.mock("../report-pipeline.js", () => ({
  runReportPipeline: vi.fn(),
}));

import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { runReportPipeline } from "../report-pipeline.js";
import { ARTIFACT_ID_PATTERN, MAX_SCREENSHOT_BYTES, registerReportRoutes } from "../routes/register-report-routes.js";

type TestRequest = { body?: unknown; file?: { buffer: Buffer; mimetype?: string } };
type TestResponse = { json: (body: unknown) => void };
type TestHandler = (req: TestRequest, res: TestResponse, next?: (error?: unknown) => void) => unknown;

function setup(projectSettings: Record<string, unknown> = { reportMode: "auto-file" }) {
  const handlers = new Map<string, TestHandler[]>();
  let uploadFile: TestRequest["file"];
  const single = vi.fn(() => async (req: TestRequest, _res: TestResponse, next: (error?: unknown) => void) => {
    req.file = uploadFile;
    next();
  });
  const router = {
    post: vi.fn((path: string, ...routeHandlers: TestHandler[]) => handlers.set(path, routeHandlers)),
  } as unknown as Router;
  const store = {
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ project: projectSettings, global: {} }),
    getRootDir: () => "/Users/alice/private-project",
    getArtifact: vi.fn().mockResolvedValue({ type: "image", metadata: { source: "report-attachment" } }),
    registerArtifact: vi.fn().mockResolvedValue({ id: "123e4567-e89b-42d3-a456-426614174000" }),
  };
  registerReportRoutes({
    router,
    getScopedStore: vi.fn().mockResolvedValue(store),
    rethrowAsApiError: (error: unknown) => { throw error; },
    reportUpload: { single },
  } as never);
  return { handlers, store, single, setUploadFile: (file: TestRequest["file"]) => { uploadFile = file; } };
}

async function invoke(handlers: TestHandler[], body: unknown) {
  const json = vi.fn();
  const req: TestRequest = { body };
  const res: TestResponse = { json };
  let index = 0;
  let nextHandler: Promise<unknown> | undefined;
  const next = (error?: unknown): void => {
    if (error) throw error;
    const handler = handlers[index++];
    if (handler) nextHandler = Promise.resolve(handler(req, res, next));
  };
  const first = handlers[index++];
  if (first) await first(req, res, next);
  // The upload middleware calls next synchronously, so await the separately
  // captured route promise to prove the handler sees the injected file.
  await nextHandler;
  return { body: json.mock.calls[0]?.[0], json, req };
}

describe("report routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes roadmap settings and a roadmap endorsement target to the pipeline", async () => {
    vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([]);
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "duplicate-found" } as never);
    const { handlers } = setup({ reportMode: "auto-file", reportRoadmapDedupeEnabled: true, reportRoadmapLabel: "roadmap" });
    await invoke(handlers.get("/report/file")!, { actionType: "idea", endorseRoadmapIssueNumber: 30, report: { userPrompt: "Dashboard report controls", body: "/Users/alice/private-project", context: {} } });
    const [input, deps, options] = vi.mocked(runReportPipeline).mock.calls.at(-1)!;
    expect(deps.projectSettings).toMatchObject({ reportRoadmapDedupeEnabled: true, reportRoadmapLabel: "roadmap" });
    expect(options).toMatchObject({ endorseRoadmapIssueNumber: 30 });
    expect((options!.report as { body: string }).body).not.toContain("private-project");
    expect(input.actionType).toBe("idea");
  });

  describe("report screenshot references", () => {
    it("runs the multipart middleware before storing only signature-validated artifacts", async () => {
      const { handlers, single, store, setUploadFile } = setup();
      const route = handlers.get("/report/attachment")!;
      expect(route).toHaveLength(2);
      expect(single).toHaveBeenCalledWith("screenshot");

      setUploadFile({ buffer: Buffer.from("not an image"), mimetype: "image/png" });
      await expect(invoke(route, {})).rejects.toThrow("PNG or JPEG");
      setUploadFile({ buffer: Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 0x89), mimetype: "image/png" });
      await expect(invoke(route, {})).rejects.toThrow("PNG or JPEG");

      setUploadFile({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimetype: "text/plain" });
      const result = await invoke(route, {});
      expect(result.body).toEqual({ artifactId: "123e4567-e89b-42d3-a456-426614174000" });
      expect(store.registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
        type: "image", authorType: "system", authorId: "report-attachment", metadata: { source: "report-attachment" }, mimeType: "image/png",
      }));
    });

    it("accepts UUID references and rejects malformed or invalid provenance on both draft and file", async () => {
      vi.mocked(runReportPipeline).mockResolvedValue({ kind: "draft-ready", mode: "draft-review", report: {} } as never);
      const { handlers, store } = setup();
      const id = "123e4567-e89b-42d3-a456-426614174000";
      expect(ARTIFACT_ID_PATTERN.test(id)).toBe(true);
      expect(ARTIFACT_ID_PATTERN.test("bad-id")).toBe(false);

      for (const path of ["/report/draft", "/report/file"]) {
        const body = path === "/report/file"
          ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } }
          : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: id };
        await invoke(handlers.get(path)!, body);
      }
      expect(runReportPipeline).toHaveBeenCalledWith(expect.objectContaining({ screenshotArtifactId: id }), expect.anything(), expect.anything());

      for (const path of ["/report/draft", "/report/file"]) {
        const malformed = path === "/report/file"
          ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: "bad-id" } }
          : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: "bad-id" };
        await expect(invoke(handlers.get(path)!, malformed)).rejects.toThrow("Screenshot artifact reference is invalid");
      }

      for (const artifact of [
        { type: "image", metadata: { source: "other-source" } },
        { type: "document", metadata: { source: "report-attachment" } },
      ]) {
        store.getArtifact.mockResolvedValue(artifact);
        for (const path of ["/report/draft", "/report/file"]) {
          const body = path === "/report/file"
            ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } }
            : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: id };
          await expect(invoke(handlers.get(path)!, body)).rejects.toThrow("Screenshot artifact is unavailable or invalid");
        }
      }
    });
  });

  describe("Help self-check", () => {
    it.each(["/report/draft", "/report/file"])("does not let direct Help %s bypass a confident knowledge answer", async (path) => {
      vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([{ title: "Use settings", summary: "Open settings first." }]);
      const { handlers } = setup();
      const response = await invoke(handlers.get(path)!, path === "/report/file"
        ? { actionType: "help", report: { userPrompt: "How do I use settings?", context: {} } }
        : { actionType: "help", userPrompt: "How do I use settings?" });
      expect(response.body).toMatchObject({ kind: "help", answer: { title: "Use settings" } });
      expect(runReportPipeline).not.toHaveBeenCalled();
    });
  });
});
