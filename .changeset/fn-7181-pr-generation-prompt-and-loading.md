---
"@runfusion/fusion": minor
---

summary: Improve AI-generated PR titles and descriptions, and show a clear loading state while the description generates.
category: feature
dev: Rewrote the pr-metadata-generator system/context prompt (exported as a named default constant) for grounded, conventional-commit-style output while preserving the strict {title,summary,changes,testing,linkedTask} JSON schema; PrCreateModal now renders a skeleton + aria-busy loading affordance with disabled inputs during generation that clears into content or the existing error/manual-fallback path.
