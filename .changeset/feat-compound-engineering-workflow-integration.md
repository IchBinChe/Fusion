---
"@runfusion/fusion": minor
---

Make the built-in compound-engineering workflow run the CE way end-to-end:

- The execute stage now invokes the `compound-engineering:ce-work` skill in coding mode instead of the generic executor prompt.
- Workflow-step sessions now carry a `FUSION_WORKFLOW_STEP` signal so skills know they are running autonomously (no synchronous question tool) and surface user questions via the await-input convention instead of a blocking prompt with no listener.
- The plugin now bundles the `ce-commit`, `ce-commit-push-pr`, and `ce-resolve-pr-feedback` skills, enabling the CE commit/PR/resolve-feedback merge flow.

(Further stages — wiring the planning-question pause + task-card answer loop, the CE merge flow, and subagent persona support — land in follow-up commits on this feature.)
