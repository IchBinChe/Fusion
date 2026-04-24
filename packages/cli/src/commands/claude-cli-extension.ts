/**
 * Resolver for the vendored `@fusion/pi-claude-cli` pi extension.
 *
 * `@fusion/pi-claude-cli` is a workspace package at `packages/pi-claude-cli/`,
 * a soft fork of rchern/pi-claude-cli (see that package's UPSTREAM.md). It
 * ships its extension entry as raw `.ts` source — pi's loader compiles TS on
 * the fly via jiti, so we just need to point pi at the right file.
 *
 * We deliberately do NOT auto-add "npm:@fusion/pi-claude-cli" to the user's
 * ~/.fusion/agent/settings.json packages array. The package is resolved from
 * this workspace at runtime and loaded explicitly only when
 * GlobalSettings.useClaudeCli is true — this avoids polluting user-owned
 * config files and lets us gate the extension on a UI toggle without
 * settings.json churn.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/**
 * Outcome of resolving the bundled @fusion/pi-claude-cli extension entry.
 *
 * - `"ok"`: the absolute path to the extension file was found — push it into
 *   the paths array passed to `discoverAndLoadExtensions`.
 * - `"not-installed"`: the package isn't in node_modules (unusual — it's a
 *   hard dep, so this typically means a corrupted install).
 * - `"missing-entry"`: the package is present but its package.json doesn't
 *   declare a pi.extensions entry, or the file it points to doesn't exist.
 *   Indicates a @fusion/pi-claude-cli version mismatch or a broken upstream release.
 * - `"error"`: something unexpected — the reason is captured so the caller
 *   can surface it in the provider card.
 */
export type ClaudeCliExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "not-installed" }
  | { status: "missing-entry"; reason: string }
  | { status: "error"; reason: string };

/**
 * Resolve the absolute path to `@fusion/pi-claude-cli`'s pi extension entry file.
 *
 * Implementation notes:
 *   - `require.resolve("@fusion/pi-claude-cli/package.json")` is the canonical way
 *     to find a package's root from a dependent module without importing the
 *     package itself. It respects pnpm's strict layout.
 *   - We read pi.extensions[0] from the package.json rather than assuming
 *     a fixed filename; if upstream renames the entry we still work.
 *   - `createRequire(import.meta.url)` anchors resolution to this module's
 *     physical location, not `process.cwd()`, so the dep is found wherever
 *     `@runfusion/fusion` itself is installed.
 */
export function resolveClaudeCliExtension(): ClaudeCliExtensionResolution {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require_.resolve("@fusion/pi-claude-cli/package.json");
  } catch {
    return { status: "not-installed" };
  }

  let pkgJson: { pi?: { extensions?: unknown }; version?: string };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof pkgJson;
  } catch (err) {
    return {
      status: "error",
      reason: `Failed to read @fusion/pi-claude-cli package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const extensions = pkgJson.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-claude-cli package.json has no pi.extensions array",
    };
  }

  const rawEntry = extensions[0];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-claude-cli pi.extensions[0] is not a valid path string",
    };
  }

  const entryPath = resolve(dirname(pkgJsonPath), rawEntry);
  if (!existsSync(entryPath)) {
    return {
      status: "missing-entry",
      reason: `@fusion/pi-claude-cli extension file not found at ${entryPath}`,
    };
  }

  return {
    status: "ok",
    path: entryPath,
    packageVersion: pkgJson.version ?? "unknown",
  };
}

/**
 * Compute the paths to append to `discoverAndLoadExtensions`' configuredPaths.
 *
 * The extension is loaded unconditionally — the provider it registers lives
 * under a distinct id (`"pi-claude-cli"`, see the vendored package's
 * index.ts) so coexistence with direct Anthropic auth is safe. When the
 * user flips `useClaudeCli` off, the provider stays registered; the dashboard
 * simply hides its models from the picker via the `/api/models` filter.
 *
 * This "always load" choice means toggling the setting has immediate effect
 * — no Fusion restart required. If `@fusion/pi-claude-cli` itself is missing
 * or broken (unusual — it's a hard workspace dep), we emit a warning and
 * return no paths; pi will continue without CLI-routed models.
 *
 * `warning` is populated when resolution fails. Callers should log it but
 * must not fail startup.
 */
export function resolveClaudeCliExtensionPaths(): {
  paths: string[];
  warning?: string;
  resolution: ClaudeCliExtensionResolution;
} {
  const resolution = resolveClaudeCliExtension();
  switch (resolution.status) {
    case "ok":
      return { paths: [resolution.path], resolution };
    case "not-installed":
      return {
        paths: [],
        resolution,
        warning:
          "@fusion/pi-claude-cli is not installed in node_modules. Run `pnpm install`.",
      };
    case "missing-entry":
    case "error":
      return { paths: [], resolution, warning: resolution.reason };
  }
}

/**
 * Last-observed resolution cached per-process. Populated by the CLI bootstrap
 * (serve/daemon/dashboard) immediately after calling
 * `resolveClaudeCliExtensionPaths`, so HTTP endpoints like
 * GET /api/providers/claude-cli/status can report the same view of the world
 * that the extension loader saw without re-probing node_modules on every
 * request.
 */
let cachedResolution: ClaudeCliExtensionResolution | null = null;

export function setCachedClaudeCliResolution(
  resolution: ClaudeCliExtensionResolution | null,
): void {
  cachedResolution = resolution;
}

export function getCachedClaudeCliResolution(): ClaudeCliExtensionResolution | null {
  return cachedResolution;
}

/**
 * Test helper: allow tests to point the resolver at a fake package.
 * Call with `undefined` to restore the real resolver. Never used in prod.
 */
// Exported for use by tests — see claude-cli-extension.test.ts
export const _testInternals = {
  moduleUrl: (): string => fileURLToPath(import.meta.url),
};
