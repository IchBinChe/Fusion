#!/usr/bin/env node
/**
 * Memory-aware development entrypoint for Fusion.
 * 
 * This script increases the Node.js heap size to prevent memory pressure
 * during the initial build/start sequence, while preserving argument
 * pass-through for documented invocations like `pnpm dev dashboard`.
 * 
 * Cross-platform: Works on Windows, macOS, and Linux.
 */

// Set increased heap size (8GB) to prevent OOM during initial build/start
const MEMORY_MB = process.env.FUSION_DEV_MEMORY_MB || "8192";
process.env.NODE_OPTIONS = `--max-old-space-size=${MEMORY_MB} ${process.env.NODE_OPTIONS || ""}`.trim();

// Spawn the actual dev command with all arguments passed through
const { spawn } = await import("child_process");
const args = process.argv.slice(2);

// If no args, run default: build + CLI
if (args.length === 0) {
  const pnpm = spawn("pnpm", ["build"], { stdio: "inherit", shell: true });
  pnpm.on("close", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    const tsx = spawn("pnpm", ["exec", "tsx", "packages/cli/src/bin.ts"], { stdio: "inherit", shell: true });
    tsx.on("close", (c) => process.exit(c ?? 1));
  });
} else {
  // Forward all arguments (e.g., "dashboard", "task list", etc.)
  const cmd = spawn("pnpm", ["build", "&&", "pnpm", "exec", "tsx", "packages/cli/src/bin.ts", ...args], { stdio: "inherit", shell: true });
  cmd.on("close", (c) => process.exit(c ?? 1));
}
