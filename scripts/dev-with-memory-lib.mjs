export function buildDevNodeArgs({
  inspectFlags = [],
  preload,
  loader,
  entry,
  args = [],
}) {
  return [
    ...inspectFlags,
    "--conditions=source",
    "--require",
    preload,
    "--import",
    `file://${loader}`,
    entry,
    ...args,
  ];
}

const VALID_PREBUILD_MODES = new Set(["auto", "none", "client", "full"]);

export function normalizePrebuildMode(value) {
  const mode = value === undefined || value === null ? "auto" : String(value).toLowerCase();
  if (mode === "" || !VALID_PREBUILD_MODES.has(mode)) {
    throw new Error(`Invalid prebuild mode "${value}". Expected one of: auto, none, client, full.`);
  }
  return mode;
}

export function hasHostOverride(args) {
  return args.includes("--host") || args.some((arg) => arg.startsWith("--host="));
}

export function buildForwardedDevArgs(args) {
  const needsDevHostInjection = args[0] === "dashboard" && !hasHostOverride(args);
  return needsDevHostInjection ? [...args, "--host", "0.0.0.0"] : args;
}

export function parseDevWrapperArgs(rawArgs, env = process.env) {
  const inspectFlags = [];
  const args = [];
  let requestedPrebuild = env.FUSION_DEV_PREBUILD ?? "auto";

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--inspect" || arg === "--inspect-brk" || arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk=")) {
      inspectFlags.push(arg);
      continue;
    }

    if (arg === "--prebuild") {
      const value = rawArgs[i + 1];
      if (!value) {
        throw new Error("Missing value for --prebuild. Expected one of: auto, none, client, full.");
      }
      requestedPrebuild = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--prebuild=")) {
      requestedPrebuild = arg.slice("--prebuild=".length);
      continue;
    }

    if (arg === "--skip-build") {
      requestedPrebuild = "none";
      continue;
    }

    args.push(arg);
  }

  return {
    inspectFlags,
    args,
    requestedPrebuild: normalizePrebuildMode(requestedPrebuild),
  };
}

export function resolvePrebuildMode(requestedPrebuild, forwardedArgs) {
  const mode = normalizePrebuildMode(requestedPrebuild);
  if (mode !== "auto") {
    return mode;
  }

  const command = forwardedArgs[0] ?? "dashboard";
  return command === "dashboard" ? "client" : "none";
}

export function getPrebuildCommand(mode) {
  switch (normalizePrebuildMode(mode)) {
    case "full":
      return { command: "pnpm", args: ["build"], label: "workspace build" };
    case "client":
      return {
        command: "pnpm",
        args: ["--filter", "@fusion/dashboard", "build:client"],
        label: "dashboard client build",
      };
    case "none":
    case "auto":
      return null;
  }
}
