#!/usr/bin/env node
/* global clearInterval, console, process, setInterval */

import { spawn } from "node:child_process";

const rawArgs = process.argv.slice(2);
const heapArg = rawArgs.find((arg) => arg.startsWith("--heap="));
const heapMb = heapArg?.slice("--heap=".length) || "6144";
const vitestArgs = rawArgs.filter((arg) => !arg.startsWith("--heap="));

if (vitestArgs.length === 0) {
  console.error("Usage: node scripts/run-vitest-with-heap.mjs [--heap=6144] <vitest args...>");
  process.exit(1);
}

const nodeOptions = [`--max-old-space-size=${heapMb}`, process.env.NODE_OPTIONS || ""]
  .join(" ")
  .trim();

function resolveSpawnCommand() {
  const override = process.env.FUSION_RUN_VITEST_SPAWN_OVERRIDE;
  if (!override) {
    return { command: "pnpm", args: ["exec", "vitest", ...vitestArgs] };
  }

  const parsedOverride = JSON.parse(override);
  if (
    !parsedOverride ||
    typeof parsedOverride.command !== "string" ||
    parsedOverride.command.length === 0 ||
    !Array.isArray(parsedOverride.args) ||
    parsedOverride.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(
      "FUSION_RUN_VITEST_SPAWN_OVERRIDE must be valid JSON with string command and string[] args",
    );
  }

  // Test seam for process-lifecycle coverage without launching real vitest.
  return { command: parsedOverride.command, args: parsedOverride.args };
}

const { command, args } = resolveSpawnCommand();
// process-supervisor-allowlist: foreground wrapper signals the entire vitest process group on death/timeout; not a background daemon
const child = spawn(command, args, {
  detached: true,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

const heartbeat = setInterval(() => {
  console.log(`[dashboard-vitest] still running: ${vitestArgs.join(" ")}`);
}, 5_000);

function clearHeartbeat() {
  clearInterval(heartbeat);
}

function forwardSignal(signal) {
  clearHeartbeat();

  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      throw error;
    }

    if (error.code !== "ESRCH" && error.code !== "EPERM") {
      throw error;
    }
  }

  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => forwardSignal(signal));
}

process.on("exit", () => {
  clearHeartbeat();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ESRCH" && error.code !== "EPERM")
    ) {
      throw error;
    }
  }
});

child.on("error", (error) => {
  clearHeartbeat();
  console.error(error);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearHeartbeat();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
