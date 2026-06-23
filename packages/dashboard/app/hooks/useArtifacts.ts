import { useState, useEffect, useRef, useCallback } from "react";
import type { ArtifactType, ArtifactWithTask } from "@fusion/core";
import { fetchArtifacts } from "../api";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";

export interface UseArtifactsResult {
  /** List of artifacts across agents and tasks */
  artifacts: ArtifactWithTask[];
  /** Loading state - true only for initial fetch, false during refresh/search */
  loading: boolean;
  /** Error message if artifact fetch failed */
  error: string | null;
  /** Refresh artifacts from the server */
  refresh: () => Promise<void>;
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-04:46:
 * The Documents Artifacts tab lists registry entries created by any agent, user, or system actor. Mirror the documents SWR pattern so cross-agent artifact search revalidates in the background without hiding the existing gallery during debounce or manual refresh.
 */
export function useArtifacts(options?: {
  /** Project ID for project-scoped fetching */
  projectId?: string;
  /** Filter artifacts by media type */
  type?: ArtifactType;
  /** Filter artifacts by author id */
  authorId?: string;
  /** Filter artifacts by parent task id */
  taskId?: string;
  /** Search query for artifact title/description */
  searchQuery?: string;
}): UseArtifactsResult {
  const { projectId, type, authorId, taskId, searchQuery } = options ?? {};
  const filterKey = JSON.stringify({ type: type ?? null, authorId: authorId ?? null, taskId: taskId ?? null });
  const cacheKey = projectId ? `${SWR_CACHE_KEYS.ARTIFACTS_PREFIX}${projectId}:${filterKey}` : null;
  const [artifacts, setArtifacts] = useState<ArtifactWithTask[]>(() => {
    if (!cacheKey) {
      return [];
    }
    const cached = readCache<ArtifactWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [loading, setLoading] = useState(() => artifacts.length === 0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const initialLoadCompleteRef = useRef(artifacts.length > 0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const requestController = new AbortController();
    abortRef.current = requestController;

    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    try {
      const fetched = await fetchArtifacts({
        type,
        authorId,
        taskId,
        q: searchQuery,
      }, projectId);

      if (requestController.signal.aborted) {
        return;
      }

      setArtifacts(fetched);
      if (cacheKey) {
        const cachedPayload = fetched.length > 500 ? fetched.slice(0, 500) : fetched;
        writeCache(cacheKey, cachedPayload, { maxBytes: 500_000 });
      }
      initialLoadCompleteRef.current = true;
    } catch (err) {
      if (requestController.signal.aborted) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!requestController.signal.aborted && isInitial) {
        setLoading(false);
      }
    }
  }, [authorId, cacheKey, projectId, searchQuery, taskId, type]);

  useEffect(() => {
    if (!cacheKey) {
      initialLoadCompleteRef.current = false;
      setArtifacts([]);
      setLoading(true);
      return;
    }

    const cached = readCache<ArtifactWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    if (Array.isArray(cached)) {
      setArtifacts(cached);
      initialLoadCompleteRef.current = true;
      setLoading(false);
    } else {
      initialLoadCompleteRef.current = false;
      setArtifacts([]);
      setLoading(true);
    }
  }, [cacheKey]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      void refresh();
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    artifacts,
    loading,
    error,
    refresh,
  };
}
