import { definePlugin } from "@fusion/plugin-sdk";
import { createRoadmapPluginRoutes } from "./roadmap-routes.js";
import { ensureRoadmapSchema } from "./roadmap-schema.js";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-roadmap",
    name: "Roadmaps",
    version: "0.1.0",
    description: "Standalone roadmap planning plugin",
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureRoadmapSchema,
  },
  routes: createRoadmapPluginRoutes(),
  /*
  FNXC:RoadmapsNavigation 2026-06-22-18:50:
  The roadmap dashboard view was removed from the product surface. Keep the plugin's schema/routes/domain exports available for compatibility, but do not advertise a dashboardViews entry.
  */
});

export default plugin;

export type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
  RoadmapFeatureMoveResult,
  RoadmapMilestoneWithFeatures,
  RoadmapWithHierarchy,
  RoadmapExportBundle,
  RoadmapFeatureSourceRef,
  RoadmapFeatureTaskPlanningHandoff,
  RoadmapMissionPlanningMilestoneHandoff,
  RoadmapMissionPlanningHandoff,
} from "./roadmap-types.js";

export {
  normalizeRoadmapMilestoneOrder,
  applyRoadmapMilestoneReorder,
  normalizeRoadmapFeatureOrder,
  applyRoadmapFeatureReorder,
  moveRoadmapFeature,
} from "./roadmap-ordering.js";

export {
  mapFeatureToTaskHandoff,
  mapRoadmapToMissionHandoff,
  mapRoadmapWithHierarchyToMissionHandoff,
  mapAllFeaturesToTaskHandoffs,
} from "./roadmap-handoff.js";

export { RoadmapStore } from "./roadmap-store.js";
export type { RoadmapStoreEvents } from "./roadmap-store.js";

export { ensureRoadmapSchema } from "./roadmap-schema.js";
export * from "./server/index.js";
