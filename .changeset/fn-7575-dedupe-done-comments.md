---
"@runfusion/fusion": patch
---

summary: Stop posting two completion comments on a linked issue when a task is both imported and tracked.
category: fix
dev: A task can carry both linkages at once (GitHub adopts a sourceIssue as githubTracking.issue via `source_issue_linked`; GitLab's buildGitLabTaskProvenance always emits both), so with githubCommentOnDone/gitlabCommentOnDone on, the issue-comment and tracking-comment services both commented on the same issue. The issue-comment services now suppress themselves when the tracking service provably posts to the same target — matched on issue identity for GitHub (case-insensitive owner/repo + number) and by construction for GitLab (resolveGitLabTarget prefers the tracked item). The tracking comment wins because it carries commit/branch/PR/files plus the release lines. Tracking pointed at a different issue, tracking disabled/unlinked, and same-column re-emits (where the tracking service no-ops) all still post as before; the custom comment template no longer renders on tracked issues.
