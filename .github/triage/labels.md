# Area label definitions

Source of truth for the triage classifier. GitHub caps label descriptions at 100 characters,
so the full definitions — and the precedence rules that resolve overlaps — live here.

Derived from 152 real Fusion issues (32 open + 120 closed, 2026-07-11..20).
Percentages are of *distinct defects* (duplicates collapsed), not raw issue counts.

## Areas

### area/tasks-board — 16.5%
Tasks and the kanban board. Task modals, columns and card state, task actions, task lifecycle
(cancel/revert/done), card badges, archiving.

### area/agent-orchestration — 15.4%
The agent engine. Agent behaviour and tool surface, inter-agent messaging, heartbeats and
patrols, delegation, missions, the scheduler that moves work between states.

### area/chat — 13.2%
The chat surface. Conversation UI, message rendering and editing, pinning, streaming and
scroll behaviour, quick-chat, how tool calls are displayed in chat and logs.

### area/plugins — 11.0%
Plugins and extensions. Plugin skill delivery into sessions, plugin packaging and bundling,
extension loading failures, skill path resolution.

### area/install-setup — 7.7%
Getting Fusion running and keeping it runnable. Global/npm install, embedded PostgreSQL
(boot, encoding, locale), rebuild flows, hostname/mDNS side effects, backup and restore.

### area/planning-mode — 7.7%
The planning and interview flow. Interview questions, plan construction and display,
title/description synthesis and translation, plan output rendering.

### area/app-shell — 7.7%
App shell and cross-cutting runtime. Drawer, multi-tab session takeover, auth and token
handling, global indicators, in-app feedback. NOT a catch-all — if it fits another area, use that.

### area/mobile — 6.6%
Mobile and PWA behaviour. See the precedence rule below: this wins only when the problem
manifests *only* on mobile.

### area/settings — 6.6%
Settings screens and configuration UI, project vs global settings scope, save behaviour.
See the precedence rule below.

### area/git-worktrees — 4.4%
The git worktree and branch sandbox agents execute in. Worktree creation and scoping,
branch name collisions, phantom worktrees, validators reading the wrong branch.

### area/terminal — 2.2%
The embedded terminal surface. Smallest area; keep only while the terminal is actively worked on.

## Precedence rules

These exist because `mobile` and `settings` are **not siblings of the other areas** — they are
orthogonal axes. `mobile` is a form factor that cuts across chat, settings and the board;
`settings` is a UI type that every feature area eventually produces. Without explicit rules
a classifier coin-flips on them forever. Measured effect: ambiguity drops from ~35% to ~21%.

1. **Mobile-only manifestation wins.** If the issue only happens on mobile/PWA, use
   `area/mobile` even when it is about settings or the board.
2. **"Add or change a setting" wins for settings.** If the ask is for a new option or a change
   to configuration behaviour, use `area/settings` even if the setting belongs to another area.
3. **Conversation content → chat; chrome → the owning surface.** Message text, streaming and
   scroll belong to `area/chat`; modals, tabs and layout belong to the area that owns the modal
   (usually `area/tasks-board`).
4. **Root cause over keyword.** Label where the fix would land, not what word appears in the
   title. A keyword tells you what failed, not why.
5. **When two areas fit equally and no rule above resolves it, abstain** — apply `needs-triage`
   rather than guessing.

## Abstention

`needs-triage` is applied when:
- confidence is below threshold,
- two areas fit equally and no precedence rule resolves it,
- the title is a bare back-reference (`#2114 n'est pas résolu`) and the referenced issue's
  area cannot be resolved,
- the body is too thin to classify (a title naming nouns with no symptom).

`needs-triage` is **not consumed** by a successful guess. An issue may carry both an area label
and `needs-triage` — "I looked at it" and "it is actionable" are separate axes.

## Language

Roughly half of Fusion's issues are French, some Czech. The classifier must not treat
non-English text as low quality, spam, or incomplete. Never downgrade or flag an issue on the
basis of its language or grammar.

## What the classifier must never do

- Never create a label. Only labels that already exist on the target repo may be applied.
- Never remove or replace existing labels (`addLabels`, never `setLabels`).
- Never comment. Labels only — a comment would reply in English to a French reporter.
- Never touch an issue that already carries a human-applied area label.
