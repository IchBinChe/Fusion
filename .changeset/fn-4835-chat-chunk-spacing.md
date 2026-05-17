---
"@runfusion/fusion": patch
---

Preserve whitespace between streamed chat chunks so multi-sentence assistant replies render `. ` correctly between sentences in ChatView and QuickChatFAB (recurrence after FN-3817; fix at a different layer in the streaming pipeline).
