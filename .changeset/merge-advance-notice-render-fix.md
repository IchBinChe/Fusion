---
"@fusion/dashboard": patch
---

fix(dashboard): unbreak Merge Advance Notice banner by preserving store `this` binding in events endpoint

`GET /api/tasks/merge-advance-events` was extracting `getRunAuditEvents` off the scoped store as a bare function reference and calling it without `this`, which made `this.db.prepare(...)` throw "Cannot read properties of undefined (reading 'db')" on every request. The `useMergeAdvanceNotice` hook caught the failure silently (`catch { setEvents([]) }`), so the banner never appeared even after the merger advanced the integration branch ref.

Fix: keep the store reference and call `storeWithRunAudit.getRunAuditEvents(...)` as a method so `this` is preserved, matching the pattern used by other routes that read run-audit events.
