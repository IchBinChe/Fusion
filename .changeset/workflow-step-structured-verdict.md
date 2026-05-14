---
"@runfusion/fusion": patch
---

Add structured JSON verdict output contract for prompt-mode workflow steps. Engine now parses `json-workflow-verdict` blocks for deterministic PASS/FAIL verdicts with graceful prose fallback. Updated WS-006 prompt to use structured fast-bail. Dashboard renders verdict badges and notes.
