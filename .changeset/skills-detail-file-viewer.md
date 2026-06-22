---
"@runfusion/fusion": minor
---

Skills view detail pane: render SKILL.md as Markdown (GFM + sanitized HTML + mermaid), compact the referenced-files area while showing all files, and make each file clickable to view its content with a "Back to SKILL.md" affordance. Adds a `GET /api/skills/:id/file` endpoint for per-file content.
