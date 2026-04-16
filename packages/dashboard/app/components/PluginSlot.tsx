import type { JSX } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";

interface PluginSlotProps {
  /** The slot identifier to render (e.g., "task-detail-tab", "header-action") */
  slotId: string;
  /** Optional project ID for multi-project slot scoping */
  projectId?: string;
}

/**
 * Renders placeholder divs for all plugin UI slots matching the given slotId.
 *
 * This component is non-critical: it silently fails (returns null) for loading
 * errors, or when no plugins are registered for the slot. Each rendered slot
 * is wrapped in an ErrorBoundary to isolate plugin rendering failures from the
 * parent dashboard UI.
 *
 * Future iterations will replace placeholder divs with dynamically loaded
 * components via the plugin's componentPath.
 */
export function PluginSlot({ slotId, projectId }: PluginSlotProps): JSX.Element | null {
  const { getSlotsForId, loading, error } = usePluginUiSlots(projectId);

  // Non-critical failure — no visible UI when loading, errored, or no matching slots
  if (loading || error || !slotId) {
    return null;
  }

  const matchingEntries = getSlotsForId(slotId);

  if (matchingEntries.length === 0) {
    return null;
  }

  return (
    <ErrorBoundary level="page">
      <>
        {matchingEntries.map((entry) => (
          <div
            key={`${entry.pluginId}-${entry.slot.slotId}`}
            data-plugin-slot
            data-slot-id={entry.slot.slotId}
            data-plugin-id={entry.pluginId}
            data-component-path={entry.slot.componentPath}
            aria-label={entry.slot.label}
          />
        ))}
      </>
    </ErrorBoundary>
  );
}
