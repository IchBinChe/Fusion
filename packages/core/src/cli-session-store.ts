/**
 * CliSessionStore - Data layer for durable CLI agent session records
 * (CLI Agent Executor, U1).
 *
 * Manages CRUD for the `cli_sessions` table: the long-lived record that
 * survives executor restarts so a session can be reasoned about, resumed,
 * or reaped from its persisted state.
 *
 * Follows the same patterns as ChatStore:
 * - EventEmitter for change notifications.
 * - SQLite for structured data storage.
 * - JSON columns for nested data (autonomyPosture).
 * - Validation at the store boundary: invalid enum values are rejected.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
import {
  isCliAgentState,
  isCliSessionPurpose,
  isCliTerminationReason,
  type CliAgentState,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionCreateInput,
  type CliSessionPurpose,
  type CliSessionUpdateInput,
  type CliTerminationReason,
} from "./cli-session-types.js";

// ── Event Types ─────────────────────────────────────────────────────────

export interface CliSessionStoreEvents {
  /** Emitted when a CLI session record is created. */
  "cli-session:created": [session: CliSession];
  /** Emitted when a CLI session record is updated. */
  "cli-session:updated": [session: CliSession];
  /** Emitted when a CLI session record is deleted. */
  "cli-session:deleted": [sessionId: string];
}

// ── Row Interface ────────────────────────────────────────────────────────

/** Database row shape for cli_sessions. */
interface CliSessionRow {
  id: string;
  taskId: string | null;
  chatSessionId: string | null;
  purpose: string;
  projectId: string;
  adapterId: string;
  agentState: string;
  terminationReason: string | null;
  nativeSessionId: string | null;
  resumeAttempts: number;
  autonomyPosture: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── CliSessionStore Class ────────────────────────────────────────────────

export class CliSessionStore extends EventEmitter<CliSessionStoreEvents> {
  constructor(
    private fusionDir: string,
    private db: Database,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // ── Row-to-Object Converter ──────────────────────────────────────────

  private rowToSession(row: CliSessionRow): CliSession {
    return {
      id: row.id,
      taskId: row.taskId ?? null,
      chatSessionId: row.chatSessionId ?? null,
      purpose: row.purpose as CliSessionPurpose,
      projectId: row.projectId,
      adapterId: row.adapterId,
      agentState: row.agentState as CliAgentState,
      terminationReason: (row.terminationReason as CliTerminationReason | null) ?? null,
      nativeSessionId: row.nativeSessionId ?? null,
      resumeAttempts: row.resumeAttempts ?? 0,
      autonomyPosture: fromJson<CliAutonomyPosture>(row.autonomyPosture) ?? null,
      worktreePath: row.worktreePath ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Boundary validation ──────────────────────────────────────────────

  private assertAgentState(value: unknown): asserts value is CliAgentState {
    if (!isCliAgentState(value)) {
      throw new Error(`Invalid CLI agent state: ${JSON.stringify(value)}`);
    }
  }

  private assertPurpose(value: unknown): asserts value is CliSessionPurpose {
    if (!isCliSessionPurpose(value)) {
      throw new Error(`Invalid CLI session purpose: ${JSON.stringify(value)}`);
    }
  }

  private assertTerminationReason(
    value: unknown,
  ): asserts value is CliTerminationReason | null {
    if (value === null || value === undefined) return;
    if (!isCliTerminationReason(value)) {
      throw new Error(`Invalid CLI termination reason: ${JSON.stringify(value)}`);
    }
  }

  // ── CRUD Operations ──────────────────────────────────────────────────

  /**
   * Create a new CLI session record.
   *
   * @throws Error if any enum value (purpose / agentState / terminationReason)
   *   is invalid, or required fields are missing.
   */
  createSession(input: CliSessionCreateInput): CliSession {
    this.assertPurpose(input.purpose);
    const agentState: CliAgentState = input.agentState ?? "starting";
    this.assertAgentState(agentState);
    this.assertTerminationReason(input.terminationReason ?? null);

    if (!input.projectId) {
      throw new Error("CLI session requires a projectId");
    }
    if (!input.adapterId) {
      throw new Error("CLI session requires an adapterId");
    }

    const now = new Date().toISOString();
    const id = input.id ?? `cli-${randomUUID().slice(0, 8)}`;
    const resumeAttempts = input.resumeAttempts ?? 0;

    const session: CliSession = {
      id,
      taskId: input.taskId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      purpose: input.purpose,
      projectId: input.projectId,
      adapterId: input.adapterId,
      agentState,
      terminationReason: input.terminationReason ?? null,
      nativeSessionId: input.nativeSessionId ?? null,
      resumeAttempts,
      autonomyPosture: input.autonomyPosture ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO cli_sessions (
          id, taskId, chatSessionId, purpose, projectId, adapterId,
          agentState, terminationReason, nativeSessionId, resumeAttempts,
          autonomyPosture, worktreePath, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.taskId,
        session.chatSessionId,
        session.purpose,
        session.projectId,
        session.adapterId,
        session.agentState,
        session.terminationReason,
        session.nativeSessionId,
        session.resumeAttempts,
        toJsonNullable(session.autonomyPosture),
        session.worktreePath,
        session.createdAt,
        session.updatedAt,
      );

    this.db.bumpLastModified();
    this.emit("cli-session:created", session);
    return session;
  }

  /** Get a CLI session record by ID. */
  getSession(id: string): CliSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM cli_sessions WHERE id = ?")
      .get(id) as unknown as CliSessionRow | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  /**
   * List CLI session records with optional filtering.
   *
   * @returns Array of sessions ordered by updatedAt DESC.
   */
  listSessions(options?: {
    taskId?: string;
    chatSessionId?: string;
    projectId?: string;
    agentState?: CliAgentState;
    purpose?: CliSessionPurpose;
  }): CliSession[] {
    const whereClauses: string[] = [];
    const params: string[] = [];

    if (options?.taskId !== undefined) {
      whereClauses.push("taskId = ?");
      params.push(options.taskId);
    }
    if (options?.chatSessionId !== undefined) {
      whereClauses.push("chatSessionId = ?");
      params.push(options.chatSessionId);
    }
    if (options?.projectId !== undefined) {
      whereClauses.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options?.agentState !== undefined) {
      this.assertAgentState(options.agentState);
      whereClauses.push("agentState = ?");
      params.push(options.agentState);
    }
    if (options?.purpose !== undefined) {
      this.assertPurpose(options.purpose);
      whereClauses.push("purpose = ?");
      params.push(options.purpose);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM cli_sessions ${whereSql} ORDER BY updatedAt DESC`)
      .all(...params);

    return (rows as unknown as CliSessionRow[]).map((row) => this.rowToSession(row));
  }

  /** List CLI session records owned by a task. */
  listByTask(taskId: string): CliSession[] {
    return this.listSessions({ taskId });
  }

  /** List CLI session records owned by a chat session. */
  listByChatSession(chatSessionId: string): CliSession[] {
    return this.listSessions({ chatSessionId });
  }

  /**
   * Update a CLI session record.
   *
   * State, terminationReason, and resumeAttempts are written atomically in a
   * single UPDATE statement, so a state transition that also records why the
   * session ended and how many resumes were attempted cannot tear.
   *
   * @throws Error if any provided enum value is invalid.
   * @returns The updated session, or undefined if not found.
   */
  updateSession(id: string, input: CliSessionUpdateInput): CliSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;

    if (input.agentState !== undefined) {
      this.assertAgentState(input.agentState);
    }
    if (input.terminationReason !== undefined) {
      this.assertTerminationReason(input.terminationReason);
    }

    const now = new Date().toISOString();
    const setClauses: string[] = ["updatedAt = ?"];
    const params: (string | number | null)[] = [now];

    if (input.taskId !== undefined) {
      setClauses.push("taskId = ?");
      params.push(input.taskId);
    }
    if (input.chatSessionId !== undefined) {
      setClauses.push("chatSessionId = ?");
      params.push(input.chatSessionId);
    }
    if (input.agentState !== undefined) {
      setClauses.push("agentState = ?");
      params.push(input.agentState);
    }
    if (input.terminationReason !== undefined) {
      setClauses.push("terminationReason = ?");
      params.push(input.terminationReason);
    }
    if (input.nativeSessionId !== undefined) {
      setClauses.push("nativeSessionId = ?");
      params.push(input.nativeSessionId);
    }
    if (input.resumeAttempts !== undefined) {
      setClauses.push("resumeAttempts = ?");
      params.push(input.resumeAttempts);
    }
    if (input.autonomyPosture !== undefined) {
      setClauses.push("autonomyPosture = ?");
      params.push(toJsonNullable(input.autonomyPosture));
    }
    if (input.worktreePath !== undefined) {
      setClauses.push("worktreePath = ?");
      params.push(input.worktreePath);
    }

    params.push(id);

    this.db
      .prepare(`UPDATE cli_sessions SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);

    const updated = this.getSession(id)!;
    this.db.bumpLastModified();
    this.emit("cli-session:updated", updated);
    return updated;
  }

  /** Delete a CLI session record. */
  deleteSession(id: string): boolean {
    const existing = this.getSession(id);
    if (!existing) return false;

    this.db.prepare("DELETE FROM cli_sessions WHERE id = ?").run(id);
    this.db.bumpLastModified();
    this.emit("cli-session:deleted", id);
    return true;
  }
}
