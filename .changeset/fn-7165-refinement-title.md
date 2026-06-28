---
"@runfusion/fusion": minor
---

summary: Refinement tasks are now titled with the source task ID followed by the entered comment.
category: feature
dev: TaskStore.refineTask now sets title = "{sourceId}: {feedback}"; normalization is skipped to preserve the source-id prefix; FN-7165.
