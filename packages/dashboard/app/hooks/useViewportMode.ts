import { useState, useEffect } from "react";

export type ViewportMode = "mobile" | "tablet" | "desktop";

// `(max-height: 480px)` catches phones held in landscape, which can exceed
// 768 CSS px wide but stay short. Without it, landscape phones fall out of
// mobile mode and lose the bottom nav bar + get the desktop horizontally-
// scrollable board.
export const MOBILE_MEDIA_QUERY = "(max-width: 768px)";

export function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) return "mobile";
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(getViewportMode);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const tabletQuery = window.matchMedia("(min-width: 769px) and (max-width: 1024px)");

    const updateMode = () => {
      if (mobileQuery.matches) {
        setMode("mobile");
      } else if (tabletQuery.matches) {
        setMode("tablet");
      } else {
        setMode("desktop");
      }
    };

    mobileQuery.addEventListener("change", updateMode);
    tabletQuery.addEventListener("change", updateMode);
    return () => {
      mobileQuery.removeEventListener("change", updateMode);
      tabletQuery.removeEventListener("change", updateMode);
    };
  }, []);

  return mode;
}
