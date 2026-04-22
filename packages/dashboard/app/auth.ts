/**
 * Dashboard authentication: token capture, storage, and injection.
 *
 * Flow:
 *   1. On first load, if `?token=<value>` is present in the URL, capture it,
 *      store it in localStorage, and strip it from the visible URL so the
 *      secret doesn't end up in browser history or shared screenshots.
 *   2. `getAuthToken()` returns the stored token (or undefined if none).
 *   3. `installAuthFetch()` wraps `window.fetch` to inject
 *      `Authorization: Bearer <token>` on every same-origin `/api/*` call,
 *      and rewrites EventSource-style URLs by appending `fn_token=<token>`
 *      (EventSource can't set headers).
 *   4. `appendTokenQuery()` and `withTokenHeader()` are helpers for places
 *      that construct URLs directly (WebSocket upgrades, EventSource).
 *
 * If no token is configured (dashboard started with `--no-auth`), all of the
 * above no-ops — the fetch wrapper adds nothing and `appendTokenQuery` is
 * identity.
 */

const STORAGE_KEY = "fn.authToken";
const URL_PARAM = "token";
/** Query param name used when we can't set an Authorization header (EventSource, WebSocket). */
export const QUERY_TOKEN_PARAM = "fn_token";

let cachedToken: string | undefined;
let captureAttempted = false;

function readStoredToken(): string | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode / storage disabled — fall through; token stays in memory.
  }
}

/**
 * Read the `?token=...` param off the current URL (if present) and stash it
 * into localStorage, then remove it from the visible URL so the secret is not
 * retained in browser history. Returns the token if one was captured.
 *
 * Safe to call multiple times — only the first call does work.
 */
function captureTokenFromUrl(): string | undefined {
  if (captureAttempted || typeof window === "undefined") {
    return undefined;
  }
  captureAttempted = true;

  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(URL_PARAM);
    if (!token) {
      return undefined;
    }

    writeStoredToken(token);
    url.searchParams.delete(URL_PARAM);
    const cleaned = url.pathname + (url.search ? url.search : "") + url.hash;
    window.history.replaceState(window.history.state, "", cleaned);
    return token;
  } catch {
    return undefined;
  }
}

/** Return the bearer token in effect for this session, if any. */
export function getAuthToken(): string | undefined {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  const captured = captureTokenFromUrl();
  if (captured) {
    cachedToken = captured;
    return captured;
  }
  const stored = readStoredToken();
  if (stored) {
    cachedToken = stored;
    return stored;
  }
  return undefined;
}

/** Clear the stored token (e.g., on a 401 response). */
export function clearAuthToken(): void {
  cachedToken = undefined;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — worst case, a stale token sits in memory until reload.
  }
}

/** Append `fn_token=<token>` to a URL so EventSource / WebSocket can auth. */
export function appendTokenQuery(url: string): string {
  const token = getAuthToken();
  if (!token) {
    return url;
  }
  try {
    // Support both absolute and relative URLs by using a dummy base.
    const base = url.startsWith("/") || !/^[a-z]+:\/\//i.test(url)
      ? new URL(url, window.location.origin)
      : new URL(url);
    base.searchParams.set(QUERY_TOKEN_PARAM, token);
    // Preserve the original form (relative vs absolute).
    return url.startsWith("/")
      ? base.pathname + base.search + base.hash
      : base.toString();
  } catch {
    // URL too malformed to parse — fall back to naive concatenation.
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${QUERY_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  }
}

/** Merge an Authorization header onto an existing HeadersInit, if we have a token. */
export function withTokenHeader(init?: HeadersInit): HeadersInit | undefined {
  const token = getAuthToken();
  if (!token) {
    return init;
  }
  const headers = new Headers(init ?? {});
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

/**
 * Monkey-patch `window.fetch` once so every same-origin `/api/*` request gets
 * a bearer token. This covers direct `fetch()` callers that don't route
 * through the `api()` helper without requiring us to touch each one.
 */
export function installAuthFetch(): void {
  if (typeof window === "undefined" || (window as any).__fnAuthFetchInstalled) {
    return;
  }
  (window as any).__fnAuthFetchInstalled = true;

  // Ensure token is captured-from-URL before the first fetch fires.
  getAuthToken();

  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const token = getAuthToken();
    if (!token) {
      return originalFetch(input, init);
    }

    const urlString = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // Only attach the token for same-origin /api/* requests.
    const isApiCall = (() => {
      try {
        const resolved = new URL(urlString, window.location.origin);
        if (resolved.origin !== window.location.origin) return false;
        return resolved.pathname.startsWith("/api/") || resolved.pathname === "/api";
      } catch {
        return urlString.startsWith("/api/") || urlString === "/api";
      }
    })();

    if (!isApiCall) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return originalFetch(input, { ...init, headers });
  };
}
