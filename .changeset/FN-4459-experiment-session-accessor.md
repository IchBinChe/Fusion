---
"@runfusion/fusion": patch
---

Add TaskStore.getExperimentSessionStore() accessor so engine, CLI, and
dashboard surfaces resolve the ExperimentSessionStore through a single
canonical entry point (parallels getResearchStore()). Additive; no
behavior change to existing research or experiment-session code paths.
