import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export type EmbedStatus = "unknown" | "loading" | "embedded" | "blocked" | "error";

interface UsePreviewEmbedOptions {
  loadTimeoutMs?: number;
}

interface UsePreviewEmbedResult {
  embedStatus: EmbedStatus;
  setEmbedStatus: (status: EmbedStatus) => void;
  resetEmbedStatus: () => void;
  retry: () => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  handleIframeLoad: () => void;
  handleIframeError: () => void;
  isEmbedded: boolean;
  isBlocked: boolean;
  blockReason: string | null;
  /** @deprecated Use blockReason instead */
  embedContext: string | null;
}

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

const BLOCKED_CONTEXT = "This preview appears to block iframe embedding. Open it in a new tab instead.";
const ERROR_CONTEXT = "The preview URL could not be loaded. Verify the server is running and the URL is correct.";
const TIMEOUT_CONTEXT = "Preview is taking longer than expected and may block iframe embedding.";

function getContextForStatus(status: EmbedStatus): string | null {
  if (status === "blocked") {
    return BLOCKED_CONTEXT;
  }

  if (status === "error") {
    return ERROR_CONTEXT;
  }

  return null;
}

export function usePreviewEmbed(url: string | null, options: UsePreviewEmbedOptions = {}): UsePreviewEmbedResult {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const [embedStatus, setEmbedStatusState] = useState<EmbedStatus>("unknown");
  const [embedContext, setEmbedContext] = useState<string | null>(null);

  const clearLoadingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setEmbedStatus = useCallback((status: EmbedStatus) => {
    setEmbedStatusState(status);
    setEmbedContext(getContextForStatus(status));
  }, []);

  const resetEmbedStatus = useCallback(() => {
    clearLoadingTimeout();
    setEmbedStatusState("unknown");
    setEmbedContext(null);
  }, [clearLoadingTimeout]);

  const retry = useCallback(() => {
    clearLoadingTimeout();
    setEmbedStatusState("unknown");
    setEmbedContext(null);
  }, [clearLoadingTimeout]);

  const handleIframeLoad = useCallback(() => {
    const iframeEl = iframeRef.current;
    if (!iframeEl) {
      setEmbedStatus("embedded");
      return;
    }

    try {
      const frameHref = iframeEl.contentWindow?.location?.href;
      if (frameHref === "about:blank" && iframeEl.src !== "about:blank") {
        setEmbedStatus("blocked");
        return;
      }
    } catch {
      // Cross-origin access can throw; assume successful embed.
    }

    setEmbedStatus("embedded");
  }, [setEmbedStatus]);

  const handleIframeError = useCallback(() => {
    setEmbedStatus("error");
  }, [setEmbedStatus]);

  useEffect(() => {
    clearLoadingTimeout();

    if (!url) {
      setEmbedStatusState("unknown");
      setEmbedContext(null);
      return;
    }

    setEmbedStatusState("loading");
    setEmbedContext(null);
  }, [clearLoadingTimeout, url]);

  useEffect(() => {
    clearLoadingTimeout();

    if (!url || embedStatus !== "loading") {
      return;
    }

    timeoutRef.current = window.setTimeout(() => {
      setEmbedStatusState("blocked");
      setEmbedContext(TIMEOUT_CONTEXT);
      timeoutRef.current = null;
    }, loadTimeoutMs);

    return clearLoadingTimeout;
  }, [clearLoadingTimeout, embedStatus, loadTimeoutMs, url]);

  useEffect(() => clearLoadingTimeout, [clearLoadingTimeout]);

  const isEmbedded = embedStatus === "embedded";
  const isBlocked = embedStatus === "blocked" || embedStatus === "error";

  const blockReason = useMemo(() => embedContext, [embedContext]);

  return {
    embedStatus,
    setEmbedStatus,
    resetEmbedStatus,
    retry,
    iframeRef,
    handleIframeLoad,
    handleIframeError,
    isEmbedded,
    isBlocked,
    blockReason,
    embedContext,
  };
}
