---
"@runfusion/fusion": patch
---

Fix task creation failing with "node 'merge-gate' branches into 2 edges — graphs with branches require the workflow interpreter (deferred)". The built-in coding workflow now models the merge lifecycle as a branching region of merge/retry/branch-group primitives (FN-6035), but the linear workflow compiler still tried to lower those nodes and rejected their fan-out. The compiler now treats the merge-region primitive kinds (merge-gate, merge-attempt, manual-merge-hold, retry-backoff, recovery-router, branch-group-member-integration, branch-group-promotion) as an engine-owned terminal boundary — exempt from the single-edge linearity rule and never lowered to a step — so linear-prefix workflows compile to their pre-merge step list again.
