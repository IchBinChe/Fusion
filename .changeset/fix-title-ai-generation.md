---
"@dustinbyrne/kb": patch
---

Fix title auto-creation to use AI summarization instead of simple truncation. When creating a task without a title, the system now uses an AI agent to generate a proper summary of the description (3-8 words, max 60 chars). Short descriptions (3 words or less) bypass AI and use the description as-is. If the AI call fails, the task is created without a title rather than falling back to truncated text.
