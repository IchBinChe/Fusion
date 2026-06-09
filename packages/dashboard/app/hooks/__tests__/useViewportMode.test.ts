import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getViewportMode, MOBILE_MEDIA_QUERY, useViewportMode } from "../useViewportMode";

const TABLET_MEDIA_QUERY = "(min-width: 769px) and (max-width: 1024px)";

type TestMediaQueryList = MediaQueryList & {
  setMatches: (matches: boolean) => void;
  dispatchChange: () => void;
};

function createViewportMediaMock(initial: { mobile: boolean; tablet: boolean }) {
  const listeners = new Map<string, Set<() => void>>();
  const matches = new Map<string, boolean>([
    [MOBILE_MEDIA_QUERY, initial.mobile],
    [TABLET_MEDIA_QUERY, initial.tablet],
  ]);
  const queries = new Map<string, TestMediaQueryList>();

  const getQuery = (query: string): TestMediaQueryList => {
    const existing = queries.get(query);
    if (existing) return existing;

    const queryListeners = new Set<() => void>();
    listeners.set(query, queryListeners);
    const mediaQueryList = {
      get matches() {
        return matches.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.delete(listener);
      }),
      addListener: vi.fn((listener: () => void) => queryListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => queryListeners.delete(listener)),
      dispatchEvent: vi.fn(() => true),
      setMatches: (nextMatches: boolean) => {
        matches.set(query, nextMatches);
      },
      dispatchChange: () => {
        for (const listener of [...queryListeners]) listener();
      },
    } as TestMediaQueryList;
    queries.set(query, mediaQueryList);
    return mediaQueryList;
  };

  vi.stubGlobal("matchMedia", vi.fn((query: string) => getQuery(query)));

  return {
    mobileQuery: getQuery(MOBILE_MEDIA_QUERY),
    tabletQuery: getQuery(TABLET_MEDIA_QUERY),
    transition(next: { mobile: boolean; tablet: boolean }, dispatch: "mobile" | "tablet" | "both" = "both") {
      getQuery(MOBILE_MEDIA_QUERY).setMatches(next.mobile);
      getQuery(TABLET_MEDIA_QUERY).setMatches(next.tablet);
      if (dispatch === "mobile" || dispatch === "both") getQuery(MOBILE_MEDIA_QUERY).dispatchChange();
      if (dispatch === "tablet" || dispatch === "both") getQuery(TABLET_MEDIA_QUERY).dispatchChange();
    },
  };
}

describe("useViewportMode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats short landscape phones as mobile", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          query === MOBILE_MEDIA_QUERY
            ? true
            : query === "(min-width: 769px) and (max-width: 1024px)"
              ? false
              : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    expect(getViewportMode()).toBe("mobile");
    expect(renderHook(() => useViewportMode()).result.current).toBe("mobile");
  });

  it("updates from mobile to tablet when the mobile media query changes", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.transition({ mobile: false, tablet: true }, "mobile");
    });

    expect(result.current).toBe("tablet");
  });

  it("updates from tablet to mobile when the tablet media query changes", () => {
    const viewport = createViewportMediaMock({ mobile: false, tablet: true });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("tablet");

    act(() => {
      viewport.transition({ mobile: true, tablet: false }, "tablet");
    });

    expect(result.current).toBe("mobile");
  });

  it("updates from mobile to tablet on window resize when media-query change events are missed", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.mobileQuery.setMatches(false);
      viewport.tabletQuery.setMatches(true);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toBe("tablet");
  });

  it("tracks a mobile to tablet to desktop to mobile viewport cycle", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.transition({ mobile: false, tablet: true }, "tablet");
    });
    expect(result.current).toBe("tablet");

    act(() => {
      viewport.transition({ mobile: false, tablet: false }, "tablet");
    });
    expect(result.current).toBe("desktop");

    act(() => {
      viewport.transition({ mobile: true, tablet: false }, "mobile");
    });
    expect(result.current).toBe("mobile");
  });

  it("supports legacy MediaQueryList listeners without runtime errors", () => {
    const listeners: Array<() => void> = [];
    const removeListener = vi.fn((listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === MOBILE_MEDIA_QUERY,
        media: query,
        onchange: null,
        addListener: (listener: () => void) => listeners.push(listener),
        removeListener,
      })),
    );

    renderHook(() => useViewportMode());

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
