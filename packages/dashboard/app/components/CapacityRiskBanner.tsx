import type { CapacityRiskSignal } from "@fusion/core";
import { X } from "lucide-react";
import "./CapacityRiskBanner.css";

interface CapacityRiskBannerProps {
  signal: CapacityRiskSignal | null;
  onDismiss?: () => void;
}

export function CapacityRiskBanner({ signal, onDismiss }: CapacityRiskBannerProps) {
  if (!signal || !signal.atRisk) {
    return null;
  }

  return (
    <div className={`capacity-risk-banner${onDismiss ? " capacity-risk-banner--dismissible" : ""}`} role="status" aria-live="polite">
      <div className="capacity-risk-banner__content">
        <strong>Capacity risk:</strong> Todo {signal.todoCount} (threshold {signal.threshold}) · In Progress {signal.inProgressCount} · In Review {signal.inReviewCount} · Idle agents {signal.idleNonEphemeralAgentCount}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="capacity-risk-banner__dismiss touch-target"
          aria-label="Dismiss capacity warning"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
