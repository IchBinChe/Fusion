import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import { createResolvedAgentSession } from "../agent-session-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/*
FNXC:GrokCliRouting 2026-07-15-09:45:
Auto-merge was failing with "Grok CLI models require the bundled Grok CLI runtime" while dashboard chat worked, because project-engine's runAiMerge options omitted pluginRunner. ChatManager already receives engine.getPluginRunner(); the merge door must forward the same runner so createResolvedAgentSession can resolve getRuntimeById("grok") for grok-cli/no-key selections.
*/
describe("AI merge PluginRunner wiring for Grok CLI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("project-engine merge door forwards this.getPluginRunner() into mergerOptions", () => {
    const source = readFileSync(resolve(__dirname, "../project-engine.ts"), "utf8");
    const optionsIndex = source.indexOf("const mergerOptions = {");
    const pluginRunnerIndex = source.indexOf("pluginRunner: this.getPluginRunner()", optionsIndex);
    const runAiMergeIndex = source.indexOf("return runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)", optionsIndex);

    expect(optionsIndex).toBeGreaterThanOrEqual(0);
    expect(pluginRunnerIndex).toBeGreaterThan(optionsIndex);
    expect(runAiMergeIndex).toBeGreaterThan(pluginRunnerIndex);
  });

  it("createResolvedAgentSession routes merger grok-cli selections through the provided PluginRunner", async () => {
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);

    const createSession = vi.fn().mockResolvedValue({
      session: {
        model: "grok-4.5",
        messages: [],
        dispose: vi.fn(),
      },
    });
    const grokRuntime = {
      id: "grok",
      name: "Grok Runtime",
      createSession,
      promptWithFallback: vi.fn(),
      describeModel: vi.fn(() => "grok/grok-4.5"),
    };
    const registration = {
      pluginId: "fusion-plugin-grok-runtime",
      runtime: {
        metadata: { runtimeId: "grok", name: "Grok Runtime" },
        factory: vi.fn().mockResolvedValue(grokRuntime),
      },
    };
    const pluginRunner = {
      getPluginRuntimes: vi.fn().mockReturnValue([registration]),
      getRuntimeById: vi.fn().mockReturnValue(registration),
      createRuntimeContext: vi.fn().mockResolvedValue({
        pluginId: "fusion-plugin-grok-runtime",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      }),
    };

    const result = await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner: pluginRunner as never,
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "merge",
    });

    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("grok");
    expect(result.runtimeId).toBe("grok");
    expect(createSession).toHaveBeenCalled();
  });

  it("throws the dual-remediation error for merger grok-cli when pluginRunner is omitted", async () => {
    vi.spyOn(fusionCore, "isGrokApiKeyFusionVisible").mockReturnValue(false);

    await expect(createResolvedAgentSession({
      sessionPurpose: "merger",
      // Intentionally omit pluginRunner — the pre-fix auto-merge wiring bug.
      cwd: "/tmp/project",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
      systemPrompt: "merge",
    })).rejects.toThrow(/Install and enable the Grok CLI runtime plugin, or set GROK_API_KEY/);
  });
});
