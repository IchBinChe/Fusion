---
"@runfusion/fusion": minor
---

Add Droid CLI provider integration: new auth and status routes (`GET /api/providers/droid-cli/status`, `POST /api/auth/droid-cli`) plus a Settings toggle hook for enabling Droid CLI–based authentication. Wired into the onboarding provider card so users can connect Droid CLI from the same flow as the other providers.
