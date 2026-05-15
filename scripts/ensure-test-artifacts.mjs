#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_BUILD_PACKAGES = [
  { name: "@fusion/core", requiredArtifacts: ["packages/core/dist/index.js"] },
  { name: "@fusion/dashboard", requiredArtifacts: ["packages/dashboard/dist/index.js"] },
  {
    name: "@fusion/engine",
    requiredArtifacts: ["packages/engine/dist/index.js"],
    staleAgainstGlobs: [{ sourcePath: "packages/engine/src" }],
  },
  { name: "@fusion/plugin-sdk", requiredArtifacts: ["packages/plugin-sdk/dist/index.js"] },
  {
    name: "@fusion-plugin-examples/dependency-graph",
    requiredArtifacts: [
      "plugins/fusion-plugin-dependency-graph/dist/index.js",
      "plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-dependency-graph/src" }],
  },
  {
    name: "@fusion-plugin-examples/hermes-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-hermes-runtime/dist/index.js",
      "plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-hermes-runtime/src" }],
  },
  {
    name: "@fusion-plugin-examples/openclaw-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-openclaw-runtime/dist/index.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/pi-module.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/probe.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-openclaw-runtime/src" }],
  },
  {
    name: "@fusion-plugin-examples/paperclip-runtime",
    requiredArtifacts: ["plugins/fusion-plugin-paperclip-runtime/dist/index.js"],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-paperclip-runtime/src" }],
  },
];

function collectNewestSourceMtimeMs(sourceDir, statFn, readdirFn) {
  let newest = 0;
  const stack = [sourceDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirFn(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(fullPath);
        continue;
      }

      let stats;
      try {
        stats = statFn(fullPath);
      } catch {
        continue;
      }
      newest = Math.max(newest, stats.mtimeMs);
    }
  }

  return newest;
}

export function isStale(
  pkgEntry,
  rootDir = process.cwd(),
  statFn = statSync,
  readdirFn = readdirSync,
  existsFn = existsSync,
) {
  if (!pkgEntry?.staleAgainstGlobs?.length) return false;

  let minArtifactMtimeMs = Number.POSITIVE_INFINITY;
  for (const artifactPath of pkgEntry.requiredArtifacts) {
    const fullPath = path.join(rootDir, artifactPath);
    if (!existsFn(fullPath)) continue;
    let stats;
    try {
      stats = statFn(fullPath);
    } catch {
      continue;
    }
    minArtifactMtimeMs = Math.min(minArtifactMtimeMs, stats.mtimeMs);
  }

  if (!Number.isFinite(minArtifactMtimeMs)) return false;

  let maxSourceMtimeMs = 0;
  for (const { sourcePath } of pkgEntry.staleAgainstGlobs) {
    const sourceDir = path.join(rootDir, sourcePath);
    maxSourceMtimeMs = Math.max(maxSourceMtimeMs, collectNewestSourceMtimeMs(sourceDir, statFn, readdirFn));
  }

  return maxSourceMtimeMs > minArtifactMtimeMs;
}

export function detectMissingOrStaleArtifacts(
  rootDir = process.cwd(),
  existsFn = existsSync,
  statFn = statSync,
  readdirFn = readdirSync,
) {
  return REQUIRED_BUILD_PACKAGES.filter((pkg) => {
    const missing = pkg.requiredArtifacts.some((artifactPath) => !existsFn(path.join(rootDir, artifactPath)));
    if (missing) return true;
    return isStale(pkg, rootDir, statFn, readdirFn, existsFn);
  });
}

export function detectMissingArtifacts(rootDir = process.cwd(), existsFn = existsSync, statFn = statSync, readdirFn = readdirSync) {
  return detectMissingOrStaleArtifacts(rootDir, existsFn, statFn, readdirFn);
}

function classifyArtifactIssues(pkgEntry, rootDir, existsFn, statFn, readdirFn) {
  const missingPaths = pkgEntry.requiredArtifacts.filter((artifactPath) => !existsFn(path.join(rootDir, artifactPath)));
  if (missingPaths.length > 0) {
    return { missingPaths, stalePaths: [] };
  }
  if (isStale(pkgEntry, rootDir, statFn, readdirFn, existsFn)) {
    return { missingPaths: [], stalePaths: [...pkgEntry.requiredArtifacts] };
  }
  return { missingPaths: [], stalePaths: [] };
}

function writeRemediation(stderrWrite, pkgEntries, filterCommand, rootDir, existsFn = existsSync, statFn = statSync, readdirFn = readdirSync) {
  stderrWrite("\n[test-bootstrap] FAILED: workspace dist artifact rebuild did not complete.\n");
  stderrWrite(`[test-bootstrap] command: ${filterCommand}\n`);
  stderrWrite(`[test-bootstrap] affected packages: ${pkgEntries.map((pkg) => pkg.name).join(", ")}\n`);
  for (const pkgEntry of pkgEntries) {
    const { missingPaths, stalePaths } = classifyArtifactIssues(pkgEntry, rootDir, existsFn, statFn, readdirFn);
    for (const missingPath of missingPaths) {
      stderrWrite(`[test-bootstrap] missing: ${missingPath}\n`);
    }
    for (const stalePath of stalePaths) {
      stderrWrite(`[test-bootstrap] stale (src newer than dist): ${stalePath}\n`);
    }
  }
  stderrWrite("[test-bootstrap] next steps:\n");
  stderrWrite("  1) pnpm install --frozen-lockfile\n");
  stderrWrite("  2) pnpm --filter <pkg> build\n");
  stderrWrite("  3) delete <plugin>/dist and re-run pnpm test\n");
  stderrWrite("[test-bootstrap] reference: FN-4232, FN-4605\n\n");
}

function run(
  command,
  args,
  cwd,
  {
    exitFn = process.exit,
    stderrWrite = process.stderr.write.bind(process.stderr),
    spawnFn = spawnSync,
    pkgEntries = [],
    existsFn = existsSync,
    statFn = statSync,
    readdirFn = readdirSync,
  } = {},
) {
  const result = spawnFn(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    const filterCommand = `${command} ${args.join(" ")}`;
    const packageNames = args.filter((entry, index) => args[index - 1] === "--filter");
    const packagesToReport = pkgEntries.length > 0
      ? pkgEntries
      : REQUIRED_BUILD_PACKAGES.filter((pkg) => packageNames.includes(pkg.name));
    writeRemediation(stderrWrite, packagesToReport, filterCommand, cwd, existsFn, statFn, readdirFn);
    exitFn(result.status ?? 1);
  }
}

export function ensureTestArtifacts(
  rootDir = process.cwd(),
  runFn = run,
  existsFn = existsSync,
  statFn = statSync,
  readdirFn = readdirSync,
  runOptions = {},
) {
  const missingOrStale = detectMissingOrStaleArtifacts(rootDir, existsFn, statFn, readdirFn);
  if (missingOrStale.length === 0) return [];

  const names = missingOrStale.map((pkg) => pkg.name);
  console.log(`[test-bootstrap] rebuilding workspace dist artifacts (missing or stale): ${names.join(", ")}`);
  if (runFn === run) {
    runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], rootDir, {
      ...runOptions,
      pkgEntries: missingOrStale,
      existsFn,
      statFn,
      readdirFn,
    });
  } else {
    runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], rootDir);
  }
  return names;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestArtifacts();
}
