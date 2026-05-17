import { useState, useEffect, useCallback, useRef } from "react";
import type { Agent, AgentState, AgentCapability, AgentStats } from "../api";
import { fetchAgents, fetchAgentStats } from "../api";
import { isEphemeralAgent } from "@fusion/core";
import { subscribeSse } from "../sse-bus";
import { readCache, SWR_CACHE_KEYS, writeCache } from "../utils/swrCache";

interface UseAgentsOptions {
  filterState?: AgentState | "all";
  showSystemAgents?: boolean;
}

interface AgentFilter {
  state?: AgentState;
  role?: AgentCapability;
  includeEphemeral?: boolean;
}

export function useAgents(projectId?: string, options?: UseAgentsOptions) {
  const [agents, setAgents] = useState<Agent[]>(() => {
    const cached = readCache<Agent[]>(SWR_CACHE_KEYS.AGENTS);
    return Array.isArray(cached) ? cached : [];
  });
  const [stats, setStats] = useState<AgentStats | null>(() => {
    const cached = readCache<AgentStats>(SWR_CACHE_KEYS.AGENT_STATS);
    return cached ?? null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const hasCachedHydrationRef = useRef(agents.length > 0 || stats !== null);

  const loadAgents = useCallback(async (filter?: AgentFilter) => {
    if (!hasCachedHydrationRef.current) {
      setIsLoading(true);
    }
    try {
      const filterState = options?.filterState;
      const baseFilter = filterState && filterState !== "all" ? { state: filterState } : undefined;
      const includeEphemeral = options?.showSystemAgents ?? false;
      const data = await fetchAgents(
        {
          ...baseFilter,
          ...filter,
          includeEphemeral: filter?.includeEphemeral ?? includeEphemeral,
        },
        projectId,
      );
      // Defensive dedupe: a race between the initial fetch and an SSE refresh
      // (or a backend that returned the same agent twice) would otherwise put
      // duplicate ids into every list rendered from this hook, flooding React
      // with duplicate-key warnings until the dashboard runs out of heap.
      const unique = Array.from(new Map(data.map((a) => [a.id, a])).values());
      setAgents(unique);
      writeCache(SWR_CACHE_KEYS.AGENTS, unique, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = hasCachedHydrationRef.current || unique.length > 0;
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, options?.filterState, options?.showSystemAgents]);

  const loadStats = useCallback(async () => {
    try {
      const data = await fetchAgentStats(projectId);
      setStats(data);
      writeCache(SWR_CACHE_KEYS.AGENT_STATS, data, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = true;
    } catch (err) {
      console.error("Failed to load agent stats:", err);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAgents();
    void loadStats();
  }, [loadAgents, loadStats]);

  // SSE subscription for agent events
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const refresh = () => {
      void loadAgents();
      void loadStats();
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "agent:created": refresh,
        "agent:updated": refresh,
        "agent:deleted": refresh,
        "agent:stateChanged": refresh,
        "approval:requested": refresh,
        "approval:updated": refresh,
        "approval:decided": refresh,
      },
    });
  }, [projectId, loadAgents, loadStats]);

  const refreshAgents = useCallback(async () => {
    await Promise.all([loadAgents(), loadStats()]);
  }, [loadAgents, loadStats]);

  const showSystemAgents = options?.showSystemAgents ?? false;
  const activeAgents = agents.filter((agent) => {
    if (agent.state !== "active" && agent.state !== "running") {
      return false;
    }
    return showSystemAgents || !isEphemeralAgent(agent);
  });

  return { agents, activeAgents, stats, isLoading, loadAgents, loadStats, refreshAgents };
}
