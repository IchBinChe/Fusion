import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalSettings, ProjectSettings, Settings, Task } from "@fusion/core";
import { resolveTitleSummarizerSettingsModel } from "@fusion/core";
import { createFnAgent } from "@fusion/engine";

const execAsync = promisify(execCb);
export const PR_METADATA_TIMEOUT_MS = 60_000;

export interface GeneratedPrMetadata {
  title: string;
  body: string;
  templateUsed: boolean;
}

interface AiMetadataResult {
  title: string;
  summary: string;
  changes: string;
  testing: string;
  linkedTask: string;
}

export function buildFallbackPrMetadata(task: Task): GeneratedPrMetadata {
  return {
    title: task.title ?? task.id,
    body: [
      "## Summary",
      "",
      task.description?.trim() || "Summary unavailable.",
      "",
      "## Changes",
      "",
      "- Details unavailable.",
      "",
      "## Testing",
      "",
      "- Not provided.",
      "",
      "## Linked Task",
      "",
      `Closes ${task.id}`,
    ].join("\n"),
    templateUsed: false,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAiResult(raw: string): AiMetadataResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AiMetadataResult>;
    const title = asString(parsed.title);
    const summary = asString(parsed.summary);
    const changes = asString(parsed.changes);
    const testing = asString(parsed.testing);
    const linkedTask = asString(parsed.linkedTask);
    if (!title || !summary || !changes || !testing) {
      return null;
    }
    return { title, summary, changes, testing, linkedTask };
  } catch {
    return null;
  }
}

function buildBody(result: AiMetadataResult, taskId: string): string {
  const linkedTaskLines = [result.linkedTask, `Closes ${taskId}`].filter(Boolean);
  return [
    "## Summary",
    "",
    result.summary,
    "",
    "## Changes",
    "",
    result.changes,
    "",
    "## Testing",
    "",
    result.testing,
    "",
    "## Linked Task",
    "",
    ...linkedTaskLines,
  ].join("\n");
}

function fillTemplate(template: string, result: AiMetadataResult, taskId: string): string {
  const known = new Map<string, string>([
    ["summary", result.summary],
    ["changes", result.changes],
    ["testing", result.testing],
    ["linked task", `${result.linkedTask}\n\nCloses ${taskId}`.trim()],
  ]);

  const lines = template.split(/\r?\n/);
  let i = 0;
  const out: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^(##+)\s+(.*)$/);
    if (!headingMatch) {
      out.push(line);
      i += 1;
      continue;
    }

    const heading = headingMatch[2].trim().toLowerCase();
    const replacement = known.get(heading);
    out.push(line);
    i += 1;

    const sectionBody: string[] = [];
    while (i < lines.length && !/^(##+)\s+/.test(lines[i])) {
      sectionBody.push(lines[i]);
      i += 1;
    }

    if (replacement) {
      out.push("");
      out.push(...replacement.split("\n"));
    } else {
      out.push(...sectionBody);
    }
  }

  if (!out.join("\n").includes(`Closes ${taskId}`)) {
    out.push("", "## Linked Task", "", `Closes ${taskId}`);
  }

  return out.join("\n");
}

async function runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const commandPromise = execAsync(command, {
    cwd,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  const { stdout } = signal ? await raceWithAbort(commandPromise, signal) : await commandPromise;
  return stdout.trim();
}

function createAbortError(): Error {
  const error = new Error("PR metadata generation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError();
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError();
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function disposeSessionBestEffort(session: { dispose?: () => void | Promise<void> }): void {
  try {
    const disposeResult = session.dispose?.();
    if (disposeResult && typeof (disposeResult as Promise<void>).catch === "function") {
      void (disposeResult as Promise<void>).catch(() => undefined);
    }
  } catch {
    // best effort
  }
}

function isAbortLikeError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && ("name" in error ? (error as { name?: unknown }).name === "AbortError" : false),
  );
}

async function resolveBaseBranch(task: Task, repoRoot: string, signal?: AbortSignal): Promise<string> {
  if (task.prInfo?.baseBranch) {
    return task.prInfo.baseBranch;
  }

  try {
    const stdout = await runCommand("gh repo view --json defaultBranchRef -q .defaultBranchRef.name", repoRoot, signal);
    if (stdout) return stdout;
  } catch {
    // fallback below
  }
  return "main";
}

export async function generatePrMetadata(input: {
  task: Task;
  repoRoot: string;
  settings: ProjectSettings & GlobalSettings;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GeneratedPrMetadata> {
  const { task, repoRoot, settings, signal, timeoutMs = PR_METADATA_TIMEOUT_MS } = input;
  const fallback = buildFallbackPrMetadata(task);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason instanceof Error ? signal.reason : createAbortError());
  /*
  FNXC:PrMetadataGeneration 2026-06-23-00:00:
  The Create PR dialog must receive usable title/body metadata within its UX budget even when git, template reads, provider startup, prompt streaming, or disposal misbehaves. Race every awaited operation against one shared abort signal so provider/session hangs degrade to deterministic fallback content instead of leaving the modal spinner pending indefinitely.
  */
  const timeoutId = setTimeout(() => controller.abort(createAbortError()), timeoutMs);
  const combinedSignal = controller.signal;
  const callerSignalWasActive = Boolean(signal && !signal.aborted);

  if (signal) {
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  try {
    throwIfAborted(combinedSignal);

    const baseBranch = await raceWithAbort(resolveBaseBranch(task, repoRoot, combinedSignal), combinedSignal);
    const [logOut, diffStatOut] = await raceWithAbort(Promise.all([
      runCommand(`git log --no-merges ${baseBranch}..HEAD --format=%s%n%b`, repoRoot, combinedSignal).catch(() => ""),
      runCommand(`git diff --stat ${baseBranch}..HEAD`, repoRoot, combinedSignal).catch(() => ""),
    ]), combinedSignal);

    let promptContent = "";
    try {
      const promptPath = join(repoRoot, ".fusion", "tasks", task.id, "PROMPT.md");
      promptContent = (await raceWithAbort(readFile(promptPath, "utf8"), combinedSignal)).trim();
    } catch {
      promptContent = "";
    }

    const templatePath = join(repoRoot, ".github", "pull_request_template.md");
    const templateExists = await raceWithAbort(access(templatePath).then(() => true).catch(() => false), combinedSignal);
    const template = templateExists ? await raceWithAbort(readFile(templatePath, "utf8"), combinedSignal) : "";

    const model = resolveTitleSummarizerSettingsModel(settings as Partial<Settings>);
    let aiText = "";
    const { session } = await raceWithAbort(createFnAgent({
      cwd: repoRoot,
      tools: "readonly",
      defaultProvider: model.provider,
      defaultModelId: model.modelId,
      systemPrompt: [
        "Generate GitHub PR metadata.",
        "Respond with strict JSON only.",
        "Schema: {title, summary, changes, testing, linkedTask}",
      ].join("\n"),
      onText: (delta: string) => {
        aiText += delta;
      },
    }), combinedSignal);

    try {
      const contextPrompt = [
        `Task ID: ${task.id}`,
        `Task title: ${task.title}`,
        `Task description: ${task.description ?? ""}`,
        `Base branch: ${baseBranch}`,
        "Commit log:",
        logOut || "(none)",
        "Diff stat:",
        diffStatOut || "(none)",
        "Task prompt:",
        promptContent || "(none)",
      ].join("\n\n");

      throwIfAborted(combinedSignal);
      await raceWithAbort(
        (session.prompt as (prompt: string, options?: { signal?: AbortSignal }) => Promise<unknown>)(contextPrompt, { signal: combinedSignal }),
        combinedSignal,
      );
    } finally {
      disposeSessionBestEffort(session);
    }

    const parsed = parseAiResult(aiText);
    if (!parsed) {
      return fallback;
    }

    const body = templateExists ? fillTemplate(template, parsed, task.id) : buildBody(parsed, task.id);
    return {
      title: parsed.title,
      body,
      templateUsed: templateExists,
    };
  } catch (error) {
    if (isAbortLikeError(error)) {
      return fallback;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignalWasActive) {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
