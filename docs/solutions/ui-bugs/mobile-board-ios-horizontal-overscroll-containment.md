---
title: "Mobile board iOS horizontal overscroll containment"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On iOS Safari/PWA, dragging the kanban board past the first or last column rubber-bands the column strip off screen"
  - "Horizontal edge overscroll can expose empty space and chain to the document even though the board's inner column scroll is intentional"
root_cause: css_scroll_containment_gap
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/Lane.css
  - packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts
tags:
  - ios-safari
  - mobile-board
  - overscroll-behavior
  - scroll-snap
  - css-regression-test
  - kanban
applies_when:
  - "A horizontally scrollable board or lane strip uses `overflow-x: auto` with mobile momentum scrolling"
  - "Edge dragging should keep native inner scrolling but must not chain or park content off screen"
---

# Mobile board iOS horizontal overscroll containment

## Problem

The mobile kanban board intentionally scrolls horizontally between columns using `overflow-x: auto`, `-webkit-overflow-scrolling: touch`, and `scroll-snap-type: x proximity`. On iOS Safari/PWA, that same momentum scroller can rubber-band past its first or last column if the scroller does not contain horizontal overscroll. The visible result is that the columns slide away from the viewport edge, exposing empty space and sometimes chaining the drag to the document.

## Root cause

The board had page-level mobile overscroll protection on `html, body`, but the board itself is the horizontal scroll container. The base `.board` and the mobile `@media (max-width: 768px) .board` rules declared the intended scroll and snap properties without `overscroll-behavior-x`, so iOS edge overscroll was not contained at the board boundary. Workflow and multi-lane board variants in `Lane.css` had the same independent horizontal scrollers.

## Solution

Add axis-specific containment to each horizontal board strip:

```css
.board,
.board.board-workflow-columns,
.lane-columns {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
}
```

Keep `contain` rather than `none`: the board can retain its native inner scroll feel while edge overscroll stops at the board/lane container instead of chaining outward. Do not replace this with `overflow: hidden`/`clip`, and do not switch snap back to `x mandatory`; both would regress intentional mobile column navigation.

## Regression coverage

Use a CSS-fixture test that loads the combined dashboard CSS and asserts:

- the mobile `.board` rule still has `overflow-x: auto` and `scroll-snap-type: x proximity`;
- the mobile `.board` rule declares `overscroll-behavior-x: contain`;
- the base `.board`, `.board.board-workflow-columns`, and `.lane-columns` horizontal scrollers also declare containment;
- no checked board path uses `scroll-snap-type: x mandatory`.

For FN-6378 this lives in `packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts`.
