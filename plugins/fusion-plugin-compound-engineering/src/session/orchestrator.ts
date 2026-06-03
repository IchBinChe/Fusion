import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  PlanningQuestion,
  PluginContext,
} from "@fusion/core";
import { resolveDefaultInstallTargetRoot } from "../skill-installation.js";
import { getCePipelineStore, type CePipelineStore } from "../sync/pipeline-store.js";
import type { CeSession, CeSessionStore } from "./session-store.js";
import { getCeSessionStore } from "./session-store.js";
import { getStage, type CeStageDefinition } from "./stage-registry.js";

/**
 * The stage id whose `complete` payload carries a derived task list to land on
 * the board (U7). Its skill is `ce-work` (see the stage registry).
 */
export const WORK_STAGE_ID = "work";

/**
 * The CE marker plugin id recorded on every CE-originated board task and link.
 * Kept as a constant so U8's sync code reuses the same identity.
 */
export const CE_PLUGIN_ID = "fusion-plugin-compound-engineering";

/**
 * SourceType chosen for CE-originated automated work. The work stage is a step in
 * the CE pipeline, so `workflow_step` is the closest existing provenance value
 * (vs. inventing a new SourceType). The CE marker + back-reference convenience
 * copy ride in `sourceMetadata`; the authoritative link is the pipeline-link row.
 */
export const CE_WORK_SOURCE_TYPE = "workflow_step" as const;

/**
 * COMPLETION-PAYLOAD → TASKS CONTRACT (U7).
 *
 * The `work` stage's `complete` event `data` MAY carry a `tasks` array describing
 * the board tasks to create. Each entry needs at least a `description` (the only
 * required TaskCreateInput field); `title` and `column` are optional.
 *
 *   { artifact?: string, tasks?: Array<{ title?: string, description: string, column?: Column }> }
 *
 * A missing/empty `tasks` array is a clean no-op (no board tasks, no link rows).
 * Entries with a blank description are skipped (createTask would reject them).
 */
export interface CeDerivedTaskSpec {
  title?: string;
  description: string;
  column?: string;
}

/** Default per-turn timeout. A turn that exceeds this is treated as a stall. */
const DEFAULT_TURN_TIMEOUT_MS = 120000;

/**
 * Observable event names emitted via `ctx.emitEvent`. The no-silent-loss
 * invariant requires that interrupt/error ALWAYS emit one of these AND persist
 * progress first.
 */
export const CE_EVENTS = {
  turn: "compound-engineering:session-turn",
  question: "compound-engineering:session-question",
  completed: "compound-engineering:session-completed",
  error: "compound-engineering:session-error",
  interrupted: "compound-engineering:session-interrupted",
} as const;

export class CeTurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`CE session turn timed out after ${ms}ms`);
    this.name = "CeTurnTimeoutError";
  }
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    globalThis.setTimeout(() => reject(new CeTurnTimeoutError(ms)), ms).unref?.();
  });
}

export interface OrchestratorDeps {
  ctx: PluginContext;
  /**
   * Interactive-session factory. Defaults to `ctx.createInteractiveAiSession`
   * (route contexts only); injectable for deterministic, scripted-fake tests.
   */
  createInteractiveAiSession?: CreateInteractiveAiSessionFactory;
  /** Project root used for the session cwd and artifact writes. */
  projectRoot?: string;
  /** Override the per-turn timeout (ms). */
  turnTimeoutMs?: number;
}

/**
 * CARRY-FORWARD (U2 → U5) — skill discovery wiring.
 *
 * U2 proved a `PluginSkillContribution` is NOT auto-ingested by the engine
 * skill-resolver; a physical install onto a cwd-discoverable path is required.
 * The U4 `CreateInteractiveAiSessionOptions` surface carries ONLY `cwd` (plus
 * systemPrompt/tools/provider/model) — it has NO `requestedSkillNames` /
 * `additionalSkillPaths` / `skillSelection` field. So we cannot point the
 * session at the install target the way `createFnAgent`'s `skills`/
 * `skillSelection` options would.
 *
 * The closest honest thing we CAN do today:
 *   1. Set the session `cwd` to a root under which the installed ce-* skills are
 *      discoverable by pi's DefaultResourceLoader (the install-target root).
 *   2. Name the required skill id in the systemPrompt so the agent is told which
 *      ce-* skill to apply (protocol-level instruction).
 *
 * This function computes that cwd. We PROVE reachability at the installer/
 * resolver layer (like U2 did) in the tests — the U4 options surface cannot yet
 * carry an explicit skill-path, so a complete fix needs U4's options to gain a
 * `requestedSkillNames`/`additionalSkillPaths` field forwarded into
 * `createFnAgent`. That gap is documented as a carry-forward for U6/follow-up.
 */
export function resolveStageSkillCwd(stage: CeStageDefinition, projectRoot?: string): string {
  // The install target root holds `<skillId>/SKILL.md` for each installed
  // skill; using it as the discovery root makes the stage's skill loadable.
  void stage;
  void projectRoot;
  return resolveDefaultInstallTargetRoot();
}

/**
 * Build the system prompt: instruct the agent to (a) apply the named ce-* skill
 * and (b) emit the JSON question/complete protocol the U4 seam parses.
 */
export function buildStageSystemPrompt(stage: CeStageDefinition): string {
  return [
    `You are running the Compound Engineering "${stage.stageId}" stage.`,
    `Apply the bundled skill "${stage.skillId}" (its SKILL.md is discoverable in your working directory).`,
    "",
    "Drive the stage as an interactive question/answer flow. On every turn respond with ONLY a JSON object:",
    '  - To ask the user something: {"type":"question","data":{"id":"<unique>","type":"single_select|multi_select|text|confirm","question":"...","options":[{"id":"..","label":".."}]}}',
    '  - When the stage is finished: {"type":"complete","data":{"artifact":"<full markdown document>", ...}}',
    "No markdown fences, no prose outside the JSON object.",
  ].join("\n");
}

export interface StartStageOptions {
  /** Opening user message (the stage prompt / topic). */
  openingMessage: string;
  projectId?: string | null;
}

/** Result of a single orchestrator step (start / answer / resume). */
export interface CeStepResult {
  session: CeSession;
  /** The event the seam produced for this step, if a turn ran. */
  event?: InteractiveAiSessionEvent;
}

/**
 * Drives a stage's interactive skill session: streams thinking/text, surfaces
 * questions (persisted as `awaiting_input`), accepts answers, and on `complete`
 * writes the artifact to the stage's conventional location. On interrupt/error
 * it AUTO-SAVES progress and emits an observable event — never silent loss.
 *
 * Liveness uses the interval-relative rubric (CeSessionStore.isStale): a slow
 * turn is not misclassified stale.
 */
export class CeOrchestrator {
  private readonly ctx: PluginContext;
  private readonly store: CeSessionStore;
  private readonly pipelineStore: CePipelineStore;
  private readonly factory: CreateInteractiveAiSessionFactory | undefined;
  private readonly projectRoot: string;
  private readonly turnTimeoutMs: number;
  /** Live in-memory session handles keyed by ce_session id. */
  private readonly live = new Map<string, InteractiveAiSession>();

  constructor(deps: OrchestratorDeps) {
    this.ctx = deps.ctx;
    this.store = getCeSessionStore(deps.ctx);
    this.pipelineStore = getCePipelineStore(deps.ctx);
    this.factory = deps.createInteractiveAiSession ?? deps.ctx.createInteractiveAiSession;
    this.projectRoot = deps.projectRoot ?? deps.ctx.taskStore.getRootDir();
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /** Start a fresh session for a registered stage and run the opening turn. */
  async start(stageId: string, opts: StartStageOptions): Promise<CeStepResult> {
    const stage = getStage(stageId);
    if (!stage) throw new Error(`Unknown CE stage: ${stageId}`);
    if (!this.factory) {
      throw new Error(
        "Interactive AI sessions are not available (createInteractiveAiSession is only injected on route contexts with the engine loaded).",
      );
    }

    let session = this.store.create({
      stage: stageId,
      projectId: opts.projectId ?? null,
      turnIntervalMs: this.turnTimeoutMs,
    });
    this.store.appendHistory(session.id, { role: "user", text: opts.openingMessage, at: new Date().toISOString() });

    const cwd = resolveStageSkillCwd(stage, this.projectRoot);
    const systemPrompt = buildStageSystemPrompt(stage);

    let interactive;
    try {
      interactive = await this.factory({ cwd, systemPrompt, tools: "coding" });
    } catch (err) {
      return { session: this.failSession(session.id, err), event: undefined };
    }
    this.live.set(session.id, interactive.session);
    session = this.store.update(session.id, { status: "active" }) ?? session;

    return this.runTurn(session.id, () => interactive.session.prompt(opts.openingMessage), interactive.session);
  }

  /** Answer the awaiting question and continue the loop. */
  async answer(sessionId: string, questionId: string, response: unknown): Promise<CeStepResult> {
    const session = this.requireSession(sessionId);
    const live = this.live.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live handle in this process; call resume() first.`);
    }
    if (session.status !== "awaiting_input") {
      throw new Error(`Session ${sessionId} is not awaiting input (status=${session.status}).`);
    }
    this.store.appendHistory(sessionId, {
      role: "user",
      text: JSON.stringify({ answer: response, questionId }),
      at: new Date().toISOString(),
    });
    this.store.update(sessionId, { status: "active", currentQuestion: null });
    return this.runTurn(sessionId, () => live.answer(questionId, response), live);
  }

  /**
   * Resume an `awaiting_input` or `interrupted` session. Returns its persisted
   * state pointed back at the current question. A resumed session with no live
   * in-process handle requires a fresh interactive session to continue past the
   * current question (the persisted question/history is the recovery anchor).
   */
  resume(sessionId: string): CeStepResult {
    const session = this.requireSession(sessionId);
    if (session.status === "interrupted" || session.status === "error") {
      // Resumable transition (retry for `error`, resume for `interrupted`): if a
      // question is still pending, return to awaiting_input; otherwise mark
      // active so the caller can re-run the turn with fresh input. The persisted
      // question/history is the no-loss recovery anchor either way.
      const next = session.currentQuestion
        ? this.store.update(sessionId, { status: "awaiting_input", error: null }) ?? session
        : this.store.update(sessionId, { status: "active", error: null }) ?? session;
      return { session: next };
    }
    // Already awaiting_input (or terminal completed) — return as-is (idempotent).
    return { session };
  }

  /** Read-through accessor for routes. */
  getState(sessionId: string): CeSession | undefined {
    return this.store.get(sessionId);
  }

  /**
   * Run one turn behind a timeout race, persist the resulting event, and on a
   * turn-level failure auto-save + emit. The `driver` performs the prompt/answer
   * against the live session; we then pull exactly one event.
   */
  private async runTurn(
    sessionId: string,
    driver: () => Promise<void>,
    live: InteractiveAiSession,
  ): Promise<CeStepResult> {
    let event: InteractiveAiSessionEvent;
    try {
      event = await Promise.race([
        (async () => {
          await driver();
          return live.nextEvent();
        })(),
        timeoutAfter(this.turnTimeoutMs),
      ]);
    } catch (err) {
      // Timeout or driver throw → auto-save as interrupted (progress preserved)
      // and emit an observable event. Never silent loss.
      const session = this.interruptSession(sessionId, err);
      this.disposeLive(sessionId);
      return { session, event: { type: "error", data: { message: session.error ?? "interrupted", cause: err } } };
    }

    const session = this.applyEvent(sessionId, event);
    if (event.type === "complete" || event.type === "error") {
      this.disposeLive(sessionId);
    }
    // Work bridge (U7): the work stage's completion payload lands derived tasks
    // on the board, tagged CE-originated + recorded as pipeline links. Outbound
    // only — created tasks then run the NORMAL lifecycle with no plugin hooks.
    if (event.type === "complete" && session.stage === WORK_STAGE_ID) {
      await this.landWorkTasks(session, event.data);
    }
    return { session, event };
  }

  /** Persist a seam event onto the session row + emit the matching observable event. */
  private applyEvent(sessionId: string, event: InteractiveAiSessionEvent): CeSession {
    switch (event.type) {
      case "thinking":
      case "text": {
        this.store.appendHistory(sessionId, { role: "agent", text: event.data, at: new Date().toISOString() });
        const s = this.store.update(sessionId, { status: "active" }) ?? this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.turn, { sessionId, kind: event.type });
        return s;
      }
      case "question": {
        const q: PlanningQuestion = event.data;
        this.store.appendHistory(sessionId, {
          role: "agent",
          text: JSON.stringify({ question: q }),
          at: new Date().toISOString(),
        });
        const s = this.store.update(sessionId, { status: "awaiting_input", currentQuestion: q }) ?? this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.question, { sessionId, questionId: q.id });
        return s;
      }
      case "complete": {
        const artifactPath = this.writeArtifact(sessionId, event.data);
        this.store.appendHistory(sessionId, {
          role: "agent",
          text: JSON.stringify({ complete: true }),
          at: new Date().toISOString(),
        });
        const s =
          this.store.update(sessionId, { status: "completed", currentQuestion: null, artifactPath }) ??
          this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.completed, { sessionId, artifactPath });
        return s;
      }
      case "error": {
        const message = event.data.message;
        // Error preserves progress (currentQuestion/history untouched) so retry
        // can resume. Status error; observable event emitted.
        const s = this.store.update(sessionId, { status: "error", error: message }) ?? this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.error, { sessionId, message });
        return s;
      }
    }
  }

  /**
   * Work bridge (U7). Read the derived task list from the work stage's
   * completion payload, create each as a board task tagged CE-originated, and
   * record a pipeline-link row resolving task→pipeline/stage/artifact. Zero
   * derived tasks is a clean no-op (no board tasks, no orphan link rows). The
   * created tasks then run the normal lifecycle — no hooks attached here (U8).
   */
  private async landWorkTasks(session: CeSession, data: unknown): Promise<void> {
    const specs = this.extractTaskSpecs(data);
    if (specs.length === 0) return;

    // The session is the CE pipeline run; its id is the stable pipeline id the
    // link rows (and U8's state machine) address.
    const cePipelineId = session.id;
    const ceStageId = session.stage;
    const ceArtifactPath = session.artifactPath ?? null;

    for (const spec of specs) {
      const description = spec.description.trim();
      if (!description) continue; // createTask rejects blank descriptions.

      const task = await this.ctx.taskStore.createTask({
        title: spec.title,
        description,
        column: spec.column as never,
        source: {
          sourceType: CE_WORK_SOURCE_TYPE,
          sourceSessionId: cePipelineId,
          sourceMetadata: {
            pluginId: CE_PLUGIN_ID,
            cePipelineId,
            ceStageId,
            ceArtifactPath,
          },
        },
      });

      // Authoritative back-reference (FN-5719): the link row, not task-row JSON.
      this.pipelineStore.createLink({
        taskId: task.id,
        cePipelineId,
        ceStageId,
        ceArtifactPath,
      });
    }
  }

  /** Parse the `{ tasks: [...] }` completion-payload contract; tolerant of shape. */
  private extractTaskSpecs(data: unknown): CeDerivedTaskSpec[] {
    if (!data || typeof data !== "object") return [];
    const raw = (data as { tasks?: unknown }).tasks;
    if (!Array.isArray(raw)) return [];
    const specs: CeDerivedTaskSpec[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const description = typeof e.description === "string" ? e.description : "";
      if (!description.trim()) continue;
      specs.push({
        description,
        title: typeof e.title === "string" ? e.title : undefined,
        column: typeof e.column === "string" ? e.column : undefined,
      });
    }
    return specs;
  }

  /** Persist `interrupted` with progress preserved and emit. */
  private interruptSession(sessionId: string, cause: unknown): CeSession {
    const message = cause instanceof Error ? cause.message : String(cause);
    const s =
      this.store.update(sessionId, { status: "interrupted", error: message }) ?? this.requireSession(sessionId);
    this.ctx.emitEvent(CE_EVENTS.interrupted, { sessionId, message });
    return s;
  }

  /** Persist `error` (session-create failure path) and emit. */
  private failSession(sessionId: string, cause: unknown): CeSession {
    const message = cause instanceof Error ? cause.message : String(cause);
    const s = this.store.update(sessionId, { status: "error", error: message }) ?? this.requireSession(sessionId);
    this.ctx.emitEvent(CE_EVENTS.error, { sessionId, message });
    return s;
  }

  /**
   * Write the stage artifact to its conventional location (R10). Accepts either
   * a `{ artifact: string }` payload or a raw string. Returns the absolute path.
   */
  private writeArtifact(sessionId: string, data: unknown): string {
    const session = this.requireSession(sessionId);
    const stage = getStage(session.stage);
    const location = stage?.artifactLocation ?? `docs/ce/${session.stage}/`;
    const content = this.extractArtifactContent(data);

    const target = location.endsWith("/")
      ? join(location, `${session.stage}-${session.id}.md`)
      : location;
    const abs = isAbsolute(target) ? target : join(this.projectRoot, target);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return abs;
  }

  private extractArtifactContent(data: unknown): string {
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "artifact" in data) {
      const a = (data as { artifact: unknown }).artifact;
      if (typeof a === "string") return a;
    }
    return JSON.stringify(data, null, 2);
  }

  private requireSession(sessionId: string): CeSession {
    const s = this.store.get(sessionId);
    if (!s) throw new Error(`CE session not found: ${sessionId}`);
    return s;
  }

  private disposeLive(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) {
      try {
        live.dispose();
      } catch {
        // best-effort
      }
      this.live.delete(sessionId);
    }
  }
}
