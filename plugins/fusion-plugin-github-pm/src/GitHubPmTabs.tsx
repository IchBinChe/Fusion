import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { CircleDot, Kanban, MessageSquare, Milestone, Sparkles, Tag, type LucideIcon } from "lucide-react";

/*
FNXC:GitHubPm 2026-07-24-01:00:
FUSI-008 tab model. Six declared Foundation-milestone surfaces in a fixed
canonical order. `disabled`/`disabledReason` are unused seams here -- FUSI-009
(repo context & capability gating) is the task that will actually populate
them (e.g. "Select a repository first" or a missing-scope reason) to grey out
a tab without deleting/reordering it. A disabled tab must never be selectable
and must never leak raw API error text via its reason.
*/
export type GitHubPmTabId = "issues" | "labels" | "milestones" | "discussions" | "projects" | "triage";

export interface GitHubPmTab {
  id: GitHubPmTabId;
  label: string;
  icon: LucideIcon;
  /** Set by FUSI-009 to grey out a tab that isn't usable yet (e.g. no repo selected, missing scope). */
  disabled?: boolean;
  /** Human-readable reason shown via title/aria for a disabled tab. Never raw API error text. */
  disabledReason?: string;
}

export const GITHUB_PM_TABS: readonly GitHubPmTab[] = [
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "labels", label: "Labels", icon: Tag },
  { id: "milestones", label: "Milestones", icon: Milestone },
  { id: "discussions", label: "Discussions", icon: MessageSquare },
  { id: "projects", label: "Projects", icon: Kanban },
  { id: "triage", label: "Triage", icon: Sparkles },
];

export function githubPmTabPanelId(id: GitHubPmTabId): string {
  return `github-pm-tabpanel-${id}`;
}

export function githubPmTabButtonId(id: GitHubPmTabId): string {
  return `github-pm-tab-${id}`;
}

interface GitHubPmTabsProps {
  tabs?: readonly GitHubPmTab[];
  activeTab: GitHubPmTabId;
  onChange: (id: GitHubPmTabId) => void;
}

/**
 * Accessible, keyboard-navigable tab bar (role="tablist"/"tab") for the
 * GitHub PM view shell. A disabled tab is not selectable via click or
 * keyboard and surfaces its reason through `title`/`aria-disabled` rather
 * than being hidden or reordered.
 */
export function GitHubPmTabs({ tabs = GITHUB_PM_TABS, activeTab, onChange }: GitHubPmTabsProps) {
  const buttonRefs = useRef<Map<GitHubPmTabId, HTMLButtonElement>>(new Map());

  function focusTab(id: GitHubPmTabId) {
    buttonRefs.current.get(id)?.focus();
  }

  function selectableTabs() {
    return tabs.filter((tab) => !tab.disabled);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const selectable = selectableTabs();
    if (selectable.length === 0) return;
    const currentIndex = selectable.findIndex((tab) => tab.id === activeTab);

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % selectable.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = currentIndex < 0 ? selectable.length - 1 : (currentIndex - 1 + selectable.length) % selectable.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = selectable.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const next = selectable[nextIndex];
    onChange(next.id);
    focusTab(next.id);
  }

  return (
    <div className="github-pm-tabs" role="tablist" aria-label="GitHub PM surfaces" onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) buttonRefs.current.set(tab.id, el);
              else buttonRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={githubPmTabButtonId(tab.id)}
            className="github-pm-tabs__tab"
            aria-selected={isActive}
            aria-controls={githubPmTabPanelId(tab.id)}
            aria-disabled={tab.disabled || undefined}
            disabled={tab.disabled}
            title={tab.disabled ? tab.disabledReason : undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (tab.disabled) return;
              onChange(tab.id);
            }}
          >
            <Icon aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default GitHubPmTabs;
