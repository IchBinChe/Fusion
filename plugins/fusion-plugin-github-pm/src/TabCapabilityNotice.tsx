import { AlertTriangle, HelpCircle, Info } from "lucide-react";
import type { TabCapabilityReason } from "./repo-capabilities.js";
import "./TabCapabilityNotice.css";

/*
FNXC:GithubPmCapabilities 2026-07-24-09:20:
FUSI-009 Step 5: the notice a disabled tab's content pane renders instead of its feature (or a
blank pane). Mirrors AuthDiagnosticsPanel's warning/instructions markup and design tokens
exactly (no hardcoded px/hex/rgba; component CSS lives in its own file) so this reads as the
same family of UI. Reason -> icon/tone mapping: "unknown" is informational (never a block --
the tab that renders this with reason "unknown" is NOT disabled, so this component also
supports an `informational` presentation for that case), every other reason renders as an
actionable warning with an ordered fix-path list -- never raw GitHub API error text (the
message string handed in here is already scrubbed by the server resolver).
*/

export interface TabCapabilityNoticeProps {
  /** Human-readable explanation. Must never be raw/redacted GitHub API error text. */
  message?: string;
  /** Ordered, actionable remediation steps. */
  fix?: string[];
  reason?: TabCapabilityReason;
}

const REASON_TITLE: Record<TabCapabilityReason, string> = {
  "feature-disabled": "This feature is not enabled for this repository.",
  "missing-scope": "This token lacks the scope needed for this feature.",
  unknown: "This token's scopes can't be fully confirmed.",
  "not-authenticated": "GitHub PM is not authenticated.",
  "repo-access-error": "Could not read this repository.",
};

export function TabCapabilityNotice({ message, fix, reason }: TabCapabilityNoticeProps) {
  const isInformational = reason === "unknown";
  const title = (reason && REASON_TITLE[reason]) ?? "This tab is unavailable.";
  const Icon = isInformational ? HelpCircle : AlertTriangle;

  return (
    <div
      className={`tab-capability-notice${isInformational ? " tab-capability-notice--info" : " tab-capability-notice--warning"}`}
      role={isInformational ? "status" : "alert"}
      data-testid="tab-capability-notice"
    >
      <p className="tab-capability-notice__message">
        <Icon aria-hidden="true" />
        <span>{message ?? title}</span>
      </p>
      {fix && fix.length > 0 ? (
        <ol className="tab-capability-notice__fix" data-testid="tab-capability-fix">
          {fix.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {!isInformational && (!fix || fix.length === 0) ? (
        <p className="tab-capability-notice__fallback">
          <Info aria-hidden="true" /> Check the plugin's Authentication diagnostics panel below for more detail.
        </p>
      ) : null}
    </div>
  );
}

export default TabCapabilityNotice;
