import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function readMetadataPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.reviewCheckoutPath ?? record.externalReviewCheckoutPath;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = record.reviewCheckout;
  if (nested && typeof nested === "object") {
    const path = (nested as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return undefined;
}

export function getTaskReviewCheckoutPath(task: unknown): string | undefined {
  if (!task || typeof task !== "object") return undefined;
  const record = task as Record<string, unknown>;
  return readMetadataPath(record.customFields) ?? readMetadataPath(record.branchContext) ?? readMetadataPath(record);
}

export function resolveReviewCheckoutCwd(task: unknown, fallbackCwd: string): string {
  const candidate = getTaskReviewCheckoutPath(task);
  if (!candidate || !isAbsolute(candidate)) return fallbackCwd;
  try {
    if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) return fallbackCwd;
    const realCandidate = realpathSync(candidate);
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: realCandidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!topLevel) return fallbackCwd;
    return realpathSync(topLevel);
  } catch {
    return fallbackCwd;
  }
}
