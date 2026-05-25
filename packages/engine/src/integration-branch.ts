import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);

export type IntegrationBranchSettings =
  | ProjectSettings
  | (Pick<ProjectSettings, "integrationBranch"> & { baseBranch?: unknown })
  | undefined
  | null;

export const INTEGRATION_BRANCH_FALLBACK = "main";
const warnedFallbackRootDirs = new Set<string>();

function normalize(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

function warnFallback(rootDir: string, logger: Pick<Console, "warn">): void {
  if (warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  logger.warn("[integration-branch] falling back to 'main' — origin/HEAD unset and no project override");
}

function resolveFromSettings(settings: IntegrationBranchSettings): string {
  const fromIntegration = normalize(settings?.integrationBranch);
  if (fromIntegration.length > 0) {
    return fromIntegration;
  }

  return normalize((settings as { baseBranch?: unknown } | null | undefined)?.baseBranch);
}

async function resolveFromOriginHead(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function resolveFromOriginHeadSync(rootDir: string): string {
  try {
    const stdout = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

export async function resolveIntegrationBranch(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): Promise<string> {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = await resolveFromOriginHead(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  warnFallback(rootDir, logger);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function resolveIntegrationBranchSync(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): string {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = resolveFromOriginHeadSync(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  warnFallback(rootDir, logger);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function __resetIntegrationBranchCacheForTests(): void {
  warnedFallbackRootDirs.clear();
}
