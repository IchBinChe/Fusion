/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the PaperclipRuntimeAdapter.
 * This module creates a seam that Vitest can intercept via vi.mock().
 *
 * ## Why a Seam Module?
 *
 * The pi functions (createFnAgent, promptWithFallback, describeModel) are defined
 * in packages/engine/src/pi.ts but are not exported from the @fusion/engine public API.
 * This seam provides a controlled import path that can be mocked in tests.
 *
 * ## Mocking in Tests
 *
 * Vitest can mock this module using:
 * ```typescript
 * vi.mock("../pi-module.js", () => ({
 *   createFnAgent: mockCreateFnAgent,
 *   promptWithFallback: mockPromptWithFallback,
 *   describeModel: mockDescribeModel,
 * }));
 * ```
 */

// ── Type Declarations ─────────────────────────────────────────────────────────

/** Minimal AgentSession type for the adapter */
export interface PiAgentSession {
  dispose?: () => Promise<void> | void;
}

/** Result from createFnAgent */
export interface PiAgentResult {
  session: PiAgentSession;
  sessionFile?: string;
}

/** Options for createFnAgent */
export interface PiAgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

// ── Module Export (runtime resolution) ────────────────────────────────────────

// Use CommonJS require at runtime, which Vitest can mock when using
// vi.mock() with a factory function. The key is that Vitest hoists vi.mock
// calls before module evaluation, so the mock is active when require() runs.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _piModule = require("../../../packages/engine/src/pi.js") as {
  createFnAgent: (options: PiAgentOptions) => Promise<PiAgentResult>;
  promptWithFallback: (session: PiAgentSession, prompt: string, options?: unknown) => Promise<void>;
  describeModel: (session: PiAgentSession) => string;
};

/** Create a new agent session using the pi backend */
export const createFnAgent = _piModule.createFnAgent;

/** Prompt the session with automatic retry and fallback */
export const promptWithFallback = _piModule.promptWithFallback;

/** Get a human-readable model description from a session */
export const describeModel = _piModule.describeModel;
