import { NativeSandboxBackend } from "./native.js";
import type { SandboxBackend, SandboxCapabilities } from "./types.js";

export type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
} from "./types.js";

let sandboxBackendOverrideForTests: SandboxBackend | null = null;

export function __setSandboxBackendForTests(backend: SandboxBackend | null): void {
  sandboxBackendOverrideForTests = backend;
}

export function __resetSandboxBackendForTests(): void {
  sandboxBackendOverrideForTests = null;
}

export function resolveSandboxBackend(_options?: { backendId?: SandboxCapabilities["id"] }): SandboxBackend {
  if (sandboxBackendOverrideForTests) {
    return sandboxBackendOverrideForTests;
  }

  // TODO(FN-4637/FN-4638/FN-4642): branch by backend id once additional implementations land.
  return new NativeSandboxBackend();
}
