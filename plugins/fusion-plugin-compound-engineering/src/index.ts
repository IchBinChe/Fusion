import { definePlugin } from "@fusion/plugin-sdk";
import { COMPOUND_ENGINEERING_SKILLS } from "./skills.js";
import { installBundledCeSkills } from "./skill-installation.js";
import { ensureCeSchema } from "./schema.js";
import { createSessionRoutes } from "./routes/session-routes.js";
import { createArtifactRoutes } from "./routes/artifact-routes.js";

export { CompoundEngineeringDashboardView } from "./dashboard-view.js";
export { COMPOUND_ENGINEERING_SKILLS } from "./skills.js";
export {
  installBundledCeSkills,
  resolveBundledSkillsRoot,
  resolveDefaultInstallTargetRoot,
  isPluginLocalPath,
} from "./skill-installation.js";
export { ensureCeSchema } from "./schema.js";
export { CeSessionStore, getCeSessionStore } from "./session/session-store.js";
export { CePipelineStore, getCePipelineStore } from "./sync/pipeline-store.js";
export type { CePipelineLink, CreateCePipelineLinkInput } from "./sync/pipeline-store.js";
export {
  CeOrchestrator,
  WORK_STAGE_ID,
  CE_PLUGIN_ID,
  CE_WORK_SOURCE_TYPE,
} from "./session/orchestrator.js";
export { getStage, listStages, registerStage } from "./session/stage-registry.js";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-compound-engineering",
    name: "Compound Engineering",
    version: "0.1.0",
    description: "A dedicated dashboard surface for compound-engineering artifacts and interactive ce-* sessions.",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    skills: COMPOUND_ENGINEERING_SKILLS.map((s) => ({ skillId: s.skillId, name: s.name })),
  },
  state: "installed",
  skills: COMPOUND_ENGINEERING_SKILLS,
  hooks: {
    // Idempotent DDL for the plugin-local CE tables (ce_sessions). Runs against
    // the same DB route handlers reach via ctx.taskStore.getDatabase() (U5).
    onSchemaInit: ensureCeSchema,
    // Install the bundled, pinned ce-* SKILL.md files into a plugin-local,
    // discoverable directory on load. The engine ingests
    // PluginSkillContribution only as a name; physical discovery requires the
    // files to exist on a path it scans (U2 finding). Install is idempotent
    // (skip-if-exists) and guarded to never touch a global ~/.claude/skills.
    onLoad: async (ctx) => {
      try {
        const { targetRoot, results } = installBundledCeSkills();
        const installed = results.filter((r) => r.outcome === "installed").length;
        const errored = results.filter((r) => r.outcome === "error");
        if (errored.length > 0) {
          ctx.logger.warn(
            `Compound Engineering: ${errored.length} skill(s) failed to install: ${errored
              .map((e) => `${e.skillId} (${e.reason})`)
              .join(", ")}`,
          );
        }
        ctx.logger.info(
          `Compound Engineering skills ready — installed=${installed} target=${targetRoot}`,
        );
        ctx.emitEvent("compound-engineering:skills-installed", { targetRoot, results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error(`Compound Engineering skill install failed: ${message}`);
      }
    },
  },
  routes: [...createSessionRoutes(), ...createArtifactRoutes()],
  dashboardViews: [
    {
      viewId: "compound-engineering",
      label: "Compound Engineering",
      componentPath: "./dashboard-view",
      icon: "Sparkles",
      placement: "primary",
      order: 36,
    },
  ],
});

export default plugin;
