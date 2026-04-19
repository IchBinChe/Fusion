import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectDevServerStream,
  fetchDevServerHistory,
  fetchDevServerStatus,
  restartDevServer,
  startDevServer,
  stopDevServer,
  type DevServerLogEntry,
  type DevServerSnapshot,
  type DevServerState,
} from "../api";

const MAX_LOG_ENTRIES = 500;

const DEFAULT_DEV_SERVER_STATE: DevServerState = {
  serverKey: "default",
  status: "idle",
  command: null,
  scriptName: null,
  cwd: null,
  pid: null,
  startedAt: null,
  updatedAt: new Date(0).toISOString(),
  previewUrl: null,
  previewProtocol: null,
  previewHost: null,
  previewPort: null,
  previewPath: null,
  exitCode: null,
  exitSignal: null,
  exitedAt: null,
  failureReason: null,
};

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSignature(entry: DevServerLogEntry): string {
  return `${entry.serverKey}|${entry.source}|${entry.timestamp}|${entry.message}`;
}

function dedupeLogs(entries: DevServerLogEntry[]): DevServerLogEntry[] {
  const seen = new Set<string>();
  const output: DevServerLogEntry[] = [];

  for (const entry of entries) {
    const key = logSignature(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }

  return output.length > MAX_LOG_ENTRIES
    ? output.slice(-MAX_LOG_ENTRIES)
    : output;
}

export interface UseDevServerResult {
  state: DevServerState;
  logs: DevServerLogEntry[];
  loading: boolean;
  error: string | null;
  connectionState: "connected" | "reconnecting" | "disconnected";
  start: (options: { command: string; cwd?: string; scriptName?: string }) => Promise<void>;
  stop: () => Promise<void>;
  restart: (options?: { command?: string; cwd?: string; scriptName?: string }) => Promise<void>;
  refresh: () => Promise<void>;
  manualPreviewUrl: string;
  setManualPreviewUrl: (url: string) => void;
  effectivePreviewUrl: string | null;
}

export function useDevServer(projectId?: string): UseDevServerResult {
  const [state, setState] = useState<DevServerState>(DEFAULT_DEV_SERVER_STATE);
  const [logs, setLogs] = useState<DevServerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [manualPreviewUrl, setManualPreviewUrl] = useState("");

  const contextVersionRef = useRef(0);
  const streamCloseRef = useRef<(() => void) | null>(null);

  const applySnapshot = useCallback((snapshot: DevServerSnapshot, historyLogs: DevServerLogEntry[]) => {
    setState(snapshot.state);
    setLogs(dedupeLogs([...historyLogs, ...snapshot.logs]));
  }, []);

  const refresh = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;

    const [snapshot, history] = await Promise.all([
      fetchDevServerStatus(projectId),
      fetchDevServerHistory(projectId, 300),
    ]);

    if (contextVersionRef.current !== versionAtStart) {
      return;
    }

    applySnapshot(snapshot, history.logs);
  }, [applySnapshot, projectId]);

  useEffect(() => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    streamCloseRef.current?.();
    streamCloseRef.current = null;

    setState(DEFAULT_DEV_SERVER_STATE);
    setLogs([]);
    setLoading(true);
    setError(null);
    setConnectionState("disconnected");
    setManualPreviewUrl("");

    const initialize = async () => {
      try {
        const [snapshot, history] = await Promise.all([
          fetchDevServerStatus(projectId),
          fetchDevServerHistory(projectId, 300),
        ]);

        if (contextVersionRef.current !== versionAtStart) {
          return;
        }

        applySnapshot(snapshot, history.logs);
      } catch (err) {
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        setError(normalizeError(err));
      } finally {
        if (contextVersionRef.current === versionAtStart) {
          setLoading(false);
        }
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      const connection = connectDevServerStream(projectId, {
        onState: (nextState) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          setState(nextState);
        },
        onLog: (entry) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          setLogs((prev) => dedupeLogs([...prev, entry]));
        },
        onConnectionStateChange: (nextConnectionState) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          setConnectionState(nextConnectionState);
        },
        onError: (message) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          setConnectionState("disconnected");
          setError(message);
        },
      });

      streamCloseRef.current = connection.close;
    };

    void initialize();

    return () => {
      streamCloseRef.current?.();
      streamCloseRef.current = null;
    };
  }, [applySnapshot, projectId]);

  const start = useCallback(async (options: { command: string; cwd?: string; scriptName?: string }) => {
    setError(null);
    const response = await startDevServer(options, projectId);
    setState(response.state);
  }, [projectId]);

  const stop = useCallback(async () => {
    setError(null);
    const response = await stopDevServer(projectId);
    setState(response.state);
  }, [projectId]);

  const restart = useCallback(async (options?: { command?: string; cwd?: string; scriptName?: string }) => {
    setError(null);
    const response = await restartDevServer(options, projectId);
    setState(response.state);
  }, [projectId]);

  return {
    state,
    logs,
    loading,
    error,
    connectionState,
    start,
    stop,
    restart,
    refresh,
    manualPreviewUrl,
    setManualPreviewUrl,
    effectivePreviewUrl: manualPreviewUrl.trim() || state.previewUrl,
  };
}
