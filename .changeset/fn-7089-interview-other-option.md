---
"@runfusion/fusion": minor
---

summary: Add an "Other" free-text answer to planning and mission interview questions.
category: feature
dev: single_select/multi_select questions now render a synthetic Other option backed by a reserved `_other` response key, threaded through formatResponseForAgent/history formatters in planning.ts, mission-interview.ts, and milestone-slice-interview.ts.
