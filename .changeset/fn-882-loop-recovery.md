---
"@gsxdsm/fusion": patch
---

Add loop detection recovery with compact-and-resume for stuck agents. When the stuck task detector identifies a looping agent (active but not making step progress), it now attempts an in-process compact-and-resume before falling back to kill/requeue. Context-limit errors from LLM providers are also caught and trigger compaction.
