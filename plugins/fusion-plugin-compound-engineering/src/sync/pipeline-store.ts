import { randomUUID } from "node:crypto";
import type { Database, PluginContext } from "@fusion/core";
import { ensureCeSchema } from "../schema.js";

/**
 * Plugin-local store for CE pipeline LINK records (U7).
 *
 * A link record is the addressable, durable association between a board task and
 * the CE pipeline/stage/artifact that produced it. Per FN-5719 the back-reference
 * lives HERE (a plugin-local table) — NOT in task-row JSON — so board-task
 * ownership and CE-pipeline ownership remain separate state machines and cannot
 * oscillate. A convenience copy of the ids may also ride along in the task's
 * `source.sourceMetadata`, but THIS ROW is the authoritative link.
 *
 * U7 SURFACE (intentionally minimal): create a link, list links by pipeline, and
 * find the link by taskId. U8 will EXTEND this store with the full bidirectional
 * pipeline-STATE machine (state column, status transitions, enqueue/reconcile).
 * U7 deliberately does not add any state/status field or sync behaviour so U8 can
 * layer it on without reworking the link surface.
 */
export interface CePipelineLink {
  /** Stable link-record id. */
  id: string;
  /** The board task this link points at (1:1 for U7). */
  taskId: string;
  /** The CE pipeline this task was derived under (the originating run). */
  cePipelineId: string;
  /** The CE stage id within that pipeline (e.g. "work"). */
  ceStageId: string;
  /** Absolute path to the stage artifact that drove this task, if any. */
  ceArtifactPath: string | null;
  createdAt: string;
}

interface CePipelineLinkRow {
  id: string;
  taskId: string;
  cePipelineId: string;
  ceStageId: string;
  ceArtifactPath: string | null;
  createdAt: string;
}

export interface CreateCePipelineLinkInput {
  taskId: string;
  cePipelineId: string;
  ceStageId: string;
  ceArtifactPath?: string | null;
  id?: string;
}

function rowToLink(row: CePipelineLinkRow): CePipelineLink {
  return {
    id: row.id,
    taskId: row.taskId,
    cePipelineId: row.cePipelineId,
    ceStageId: row.ceStageId,
    ceArtifactPath: row.ceArtifactPath,
    createdAt: row.createdAt,
  };
}

/**
 * CRUD for CE pipeline link records. Reaches the DB the same way the session
 * store / reports do (via `ctx.taskStore.getDatabase()`) and ensures its schema
 * defensively on construction so a store built before `onSchemaInit` ran (or in a
 * test) still works.
 */
export class CePipelineStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    ensureCeSchema(db);
  }

  /** Record a task→pipeline/artifact link. */
  createLink(input: CreateCePipelineLinkInput): CePipelineLink {
    const link: CePipelineLink = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      cePipelineId: input.cePipelineId,
      ceStageId: input.ceStageId,
      ceArtifactPath: input.ceArtifactPath ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ce_pipeline_links
          (id, taskId, cePipelineId, ceStageId, ceArtifactPath, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(link.id, link.taskId, link.cePipelineId, link.ceStageId, link.ceArtifactPath, link.createdAt);
    return link;
  }

  /** All links produced by a given CE pipeline, newest first. */
  listByPipeline(cePipelineId: string): CePipelineLink[] {
    const rows = this.db
      .prepare(`SELECT * FROM ce_pipeline_links WHERE cePipelineId = ? ORDER BY createdAt DESC, id`)
      .all(cePipelineId) as CePipelineLinkRow[];
    return rows.map(rowToLink);
  }

  /** Resolve a board task back to its CE link (the back-reference). */
  findByTaskId(taskId: string): CePipelineLink | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ce_pipeline_links WHERE taskId = ?`)
      .get(taskId) as CePipelineLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }
}

const storeCache = new WeakMap<object, CePipelineStore>();

/** WeakMap-cached store keyed by the TaskStore instance (mirrors the session store). */
export function getCePipelineStore(ctx: PluginContext): CePipelineStore {
  const key = ctx.taskStore as object;
  const cached = storeCache.get(key);
  if (cached) return cached;
  const store = new CePipelineStore(ctx.taskStore.getDatabase());
  storeCache.set(key, store);
  return store;
}
