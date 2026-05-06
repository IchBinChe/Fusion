#!/usr/bin/env node
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const BASELINE_FILE = join(tmpdir(), ".fusion-isolation-baseline");

const TRACKED_PREFIXES = [
  "fusion-worker-",
  "fusion-test-",
  "fusion-test-cwd-",
  "fusion-provider-settings-",
  "fusion-provider-auth-",
  "fusion-provider-auth-oauth-",
  "fusion-agent-dir-",
  "kb-db-test-",
  "kb-backup-test-",
  "kb-migration-test-",
  "kb-fresh-",
  "kb-needs-migration-",
  "kb-compat-test-",
  "kb-first-run-test-",
];

function stablePath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function snapshotTmp() {
  const entries = readdirSync(tmpdir());
  const matching = [];
  for (const name of entries) {
    if (!TRACKED_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(tmpdir(), name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) matching.push({ name, mtime: stat.mtimeMs });
    } catch {
      // Ignore transient file-system races while scanning /tmp.
    }
  }
  return matching;
}

function listProtectedFusionDirs() {
  const dirs = new Set();
  dirs.add(stablePath(join(process.cwd(), ".fusion")));
  dirs.add(stablePath(join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fusion")));
  return [...dirs];
}

function collectFusionSignature(rootDir, out = []) {
  if (!existsSync(rootDir)) return out;
  let stat;
  try {
    stat = statSync(rootDir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;

  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    const relPath = fullPath.slice(rootDir.length + (rootDir.endsWith(sep) ? 0 : 1));
    let entryStat;
    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }
    out.push(`${relPath}|${entry.isDirectory() ? "d" : "f"}|${entryStat.size}|${Math.floor(entryStat.mtimeMs)}`);
    if (entry.isDirectory()) collectFusionSignature(fullPath, out);
  }
  return out;
}

function snapshotProtectedFusion() {
  return listProtectedFusionDirs().map((dir) => ({
    dir,
    exists: existsSync(dir),
    entries: collectFusionSignature(dir).sort(),
  }));
}

function sleepMs(ms) {
  // Cross-platform enough for CI and local dev; fall back to best-effort no-op.
  spawnSync(process.platform === "win32" ? "powershell" : "sleep", process.platform === "win32" ? ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`] : [String(ms / 1000)], { stdio: "ignore" });
}

function recordBaseline() {
  const firstProtected = snapshotProtectedFusion();
  sleepMs(250);
  const secondProtected = snapshotProtectedFusion();

  const unstableProtectedDirs = [];
  for (const first of firstProtected) {
    const second = secondProtected.find((entry) => entry.dir === first.dir);
    if (!second) continue;
    if (JSON.stringify(first.entries) !== JSON.stringify(second.entries)) {
      unstableProtectedDirs.push(first.dir);
    }
  }

  const payload = {
    tmpNames: snapshotTmp().map((e) => e.name),
    protectedFusion: secondProtected,
    unstableProtectedDirs,
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(payload));
  console.log(`[test-isolation] Baseline recorded: ${payload.tmpNames.length} temp dir(s), ${payload.protectedFusion.length} protected .fusion root(s).`);
  if (unstableProtectedDirs.length > 0) {
    console.log(`[test-isolation] Ignoring ${unstableProtectedDirs.length} externally-active protected dir(s):`);
    for (const dir of unstableProtectedDirs) console.log(`  ${dir}`);
  }
}

function checkAgainstBaseline() {
  let baseline = { tmpNames: [], protectedFusion: [] };
  if (existsSync(BASELINE_FILE)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
    } catch {
      // Ignore malformed baseline payloads and treat as empty baseline.
    }
  }

  const baselineNames = new Set(baseline.tmpNames ?? []);
  const leaks = snapshotTmp().filter((e) => !baselineNames.has(e.name));

  const baselineByDir = new Map((baseline.protectedFusion ?? []).map((entry) => [entry.dir, entry]));
  const unstableProtectedDirs = new Set(baseline.unstableProtectedDirs ?? []);
  const currentProtected = snapshotProtectedFusion();
  const protectedViolations = [];
  for (const current of currentProtected) {
    if (unstableProtectedDirs.has(current.dir)) continue;
    const base = baselineByDir.get(current.dir) ?? { exists: false, entries: [] };
    const changedExistence = Boolean(base.exists) !== Boolean(current.exists);
    const changedEntries = JSON.stringify(base.entries) !== JSON.stringify(current.entries);
    if (changedExistence || changedEntries) {
      protectedViolations.push(current.dir);
    }
  }

  if (leaks.length === 0 && protectedViolations.length === 0) {
    console.log("[test-isolation] No temp leaks or live .fusion mutations detected.");
    process.exit(0);
  }

  if (leaks.length > 0) {
    console.error(`[test-isolation] FAIL: ${leaks.length} leaked temp director${leaks.length === 1 ? "y" : "ies"}:`);
    for (const leak of leaks) console.error(`  ${join(tmpdir(), leak.name)}`);
    console.error("");
  }

  if (protectedViolations.length > 0) {
    console.error("[test-isolation] FAIL: protected live .fusion data changed during tests:");
    for (const dir of protectedViolations) console.error(`  ${dir}`);
    console.error("Tests must use temp HOME / temp workspaces and never write repo or user .fusion data.");
  }

  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--before")) {
  recordBaseline();
} else {
  checkAgainstBaseline();
}
