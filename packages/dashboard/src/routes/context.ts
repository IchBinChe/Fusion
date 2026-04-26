import { Router, type Request, type Response } from "express";
import { resolve, sep } from "node:path";
import type { TaskStore } from "@fusion/core";
import type { ServerOptions } from "../server.js";
import { badRequest, notFound, ApiError, internalError } from "../api-error.js";
import { getOrCreateProjectStore } from "../project-store-resolver.js";
import { createRuntimeLogger } from "../runtime-logger.js";
import type {
  ApiRoutesContext,
  AuthSyncAuditLogInput,
  ProjectContext,
  RemoteRouteDiagnosticInput,
  ScopeValue,
} from "./types.js";

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error) {
    throw internalError(error.message || fallbackMessage);
  }

  throw internalError(fallbackMessage);
}

function classifyRemoteRouteError(error: unknown): {
  classification: "timeout" | "transport" | "unexpected";
  errorClass: string;
  errorMessage: string;
} {
  const fallbackMessage = String(error);

  if (error instanceof Error) {
    const errorClass = error.constructor?.name || error.name || "Error";
    const errorMessage = error.message || fallbackMessage;

    if (error.name === "AbortError") {
      return { classification: "timeout", errorClass, errorMessage };
    }

    if (error instanceof TypeError) {
      return { classification: "transport", errorClass, errorMessage };
    }

    return { classification: "unexpected", errorClass, errorMessage };
  }

  if ((error as { name?: unknown } | null)?.name === "AbortError") {
    return { classification: "timeout", errorClass: "AbortError", errorMessage: fallbackMessage };
  }

  return {
    classification: "unexpected",
    errorClass: typeof error,
    errorMessage: fallbackMessage,
  };
}

export function getProjectIdFromRequest(req: Request): string | undefined {
  if (req.query && typeof req.query.projectId === "string" && req.query.projectId.length > 0) {
    return req.query.projectId;
  }
  if (req.body && typeof req.body.projectId === "string" && req.body.projectId.length > 0) {
    return req.body.projectId;
  }
  return undefined;
}

export async function getScopedStore(req: Request, store: TaskStore): Promise<TaskStore> {
  const projectId = getProjectIdFromRequest(req);
  if (!projectId) return store;
  return getOrCreateProjectStore(projectId);
}

export async function getProjectContext(
  req: Request,
  store: TaskStore,
  options?: ServerOptions,
): Promise<ProjectContext> {
  const projectId = getProjectIdFromRequest(req);
  const engineManager = options?.engineManager;

  if (projectId && engineManager) {
    let engine = engineManager.getEngine(projectId);
    if (!engine) {
      try {
        engine = await engineManager.ensureEngine(projectId);
      } catch {
        // fall through
      }
    }
    if (engine) {
      return { store: engine.getTaskStore(), engine, projectId };
    }
  }

  const scopedStore = await getScopedStore(req, store);
  return { store: scopedStore, engine: undefined, projectId };
}

export function createApiRoutesContext(store: TaskStore, options?: ServerOptions): ApiRoutesContext {
  const router = Router();
  const runtimeLogger = options?.runtimeLogger?.child("routes") ?? createRuntimeLogger("routes");
  const planningLogger = runtimeLogger.child("planning");
  const proxyLogger = runtimeLogger.child("proxy");
  const chatLogger = runtimeLogger.child("chat");

  function prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[] {
    const cwd = resolve(process.cwd());

    const rankProject = (projectPath: string): number => {
      const normalizedProjectPath = resolve(projectPath);
      if (normalizedProjectPath === cwd) {
        return Number.MAX_SAFE_INTEGER;
      }

      const prefix = normalizedProjectPath.endsWith(sep)
        ? normalizedProjectPath
        : `${normalizedProjectPath}${sep}`;

      if (!cwd.startsWith(prefix)) {
        return -1;
      }

      return normalizedProjectPath.length;
    };

    return [...projects].sort((a, b) => rankProject(b.path) - rankProject(a.path));
  }

  const resolveScopedStore = (req: Request): Promise<TaskStore> => getScopedStore(req, store);
  const resolveProjectContext = (req: Request): Promise<ProjectContext> => getProjectContext(req, store, options);

  function emitRemoteRouteDiagnostic(input: RemoteRouteDiagnosticInput): void {
    const logger = runtimeLogger.child("remote-route").child(input.route);
    const level = input.level ?? "error";

    const context: Record<string, unknown> = {
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      ...(input.upstreamPath !== undefined ? { upstreamPath: input.upstreamPath } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.operationStage !== undefined ? { operationStage: input.operationStage } : {}),
      ...(input.context ?? {}),
    };

    if (input.error !== undefined) {
      const classified = classifyRemoteRouteError(input.error);
      context.transportClassification = classified.classification;
      context.errorClass = classified.errorClass;
      context.errorMessage = classified.errorMessage;
    }

    if (level === "info") {
      logger.info(input.message, context);
      return;
    }

    if (level === "warn") {
      logger.warn(input.message, context);
      return;
    }

    logger.error(input.message, context);
  }

  function emitAuthSyncAuditLog(input: AuthSyncAuditLogInput): void {
    const logger = runtimeLogger.child("settings-sync").child("auth");
    const level = input.level ?? "info";
    const providerNames = input.providerNames.filter((provider) => typeof provider === "string");

    const context: Record<string, unknown> = {
      operation: input.operation,
      direction: input.direction,
      route: input.route,
      providerNames,
      providerCount: providerNames.length,
      ...(input.sourceNodeId !== undefined ? { sourceNodeId: input.sourceNodeId } : {}),
      ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
    };

    if (level === "warn") {
      logger.warn("Auth sync diagnostic event", context);
      return;
    }

    if (level === "error") {
      logger.error("Auth sync diagnostic event", context);
      return;
    }

    logger.info("Auth sync diagnostic event", context);
  }

  async function proxyToRemoteNode(
    req: Request,
    res: Response,
    remotePath: string,
    proxyOptions?: { timeoutMs?: number },
  ): Promise<void> {
    const nodeId = req.params.nodeId as string;
    const timeoutMs = proxyOptions?.timeoutMs ?? 10_000;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getFusionDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) throw notFound("Node not found");
      if (node.type === "local") throw badRequest("Cannot proxy to local node");
      if (!node.url) throw badRequest("Node has no URL configured");

      const parsedUrl = new URL(req.url, "http://localhost");
      const queryString = parsedUrl.search;
      const targetPath = `/api${remotePath}${queryString}`;
      const targetUrl = new URL(targetPath, node.url).toString();

      const headers: Record<string, string> = {};
      if (node.apiKey) {
        headers.Authorization = `Bearer ${node.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(targetUrl, { headers, signal: controller.signal });
      clearTimeout(timeout);

      const hopByHopHeaders = new Set([
        "transfer-encoding",
        "connection",
        "keep-alive",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
      ]);

      response.headers.forEach((value, key) => {
        if (!hopByHopHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.status(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      nodeStream.on("data", (chunk: Buffer) => {
        res.write(chunk);
      });

      nodeStream.on("end", () => {
        res.end();
      });

      nodeStream.on("error", (err: Error) => {
        proxyLogger.error(`Stream error for node ${nodeId}`, { error: err.message });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      if (res.headersSent) {
        return;
      }
      if (err instanceof Error && err.name === "AbortError") {
        res.status(504).json({ error: "Remote node timeout" });
      } else if (err instanceof TypeError) {
        res.status(502).json({ error: "Remote node unreachable" });
      } else if (err instanceof ApiError) {
        throw err;
      } else if (err instanceof Error && err.message) {
        throw new ApiError(500, err.message);
      } else {
        throw new ApiError(500, "Proxy request failed");
      }
    } finally {
      await central.close();
    }
  }

  function parseScopeParam(req: Request): ScopeValue | undefined {
    const rawScope =
      (typeof req.query.scope === "string" ? req.query.scope : undefined) ??
      (req.body && typeof req.body.scope === "string" ? req.body.scope : undefined);

    if (rawScope === undefined || rawScope === "") {
      return undefined;
    }

    if (rawScope !== "global" && rawScope !== "project") {
      throw new ApiError(400, `Invalid scope value "${rawScope}". Must be "global" or "project".`);
    }

    return rawScope;
  }

  function resolveAutomationStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").AutomationStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.automationStore;
      if (!defaultStore) {
        throw new ApiError(503, "Automation store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getAutomationStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    const defaultStore = options?.automationStore;
    if (!defaultStore) {
      throw new ApiError(503, "Automation store not available");
    }
    return defaultStore;
  }

  function resolveRoutineStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").RoutineStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.routineStore;
      if (!defaultStore) {
        throw new ApiError(503, "Routine store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getRoutineStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    const defaultStore = options?.routineStore;
    if (!defaultStore) {
      throw new ApiError(503, "Routine store not available");
    }
    return defaultStore;
  }

  function resolveRoutineRunner(req: Request, scope: ScopeValue | undefined): NonNullable<ServerOptions["routineRunner"]> {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "project" && projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineRunner = engine.getRoutineRunner();
        if (engineRunner) {
          return {
            triggerManual: engineRunner.triggerManual.bind(engineRunner),
            triggerWebhook: engineRunner.triggerWebhook.bind(engineRunner),
          };
        }
      }
    }

    const runner = options?.routineRunner;
    if (!runner) {
      throw new ApiError(503, "Routine execution not available");
    }
    return runner;
  }

  return {
    router,
    store,
    options,
    runtimeLogger,
    planningLogger,
    proxyLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore: resolveScopedStore,
    getProjectContext: resolveProjectContext,
    emitRemoteRouteDiagnostic,
    emitAuthSyncAuditLog,
    proxyToRemoteNode,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    rethrowAsApiError,
  };
}
