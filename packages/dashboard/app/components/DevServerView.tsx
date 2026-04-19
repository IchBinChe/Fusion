import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Server, Square, Play } from "lucide-react";
import { fetchScripts } from "../api";
import { useDevServer } from "../hooks/useDevServer";

interface DevServerViewProps {
  projectId?: string;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export function DevServerView({ projectId }: DevServerViewProps) {
  const {
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
    effectivePreviewUrl,
  } = useDevServer(projectId);

  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptName, setScriptName] = useState<string>("");
  const [command, setCommand] = useState("");
  const [actionPending, setActionPending] = useState<"start" | "stop" | "restart" | null>(null);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const previewLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    fetchScripts(projectId)
      .then((result) => {
        if (!cancelled) {
          setScripts(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScripts({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (state.command && command.trim().length === 0) {
      setCommand(state.command);
      return;
    }

    if (!state.command && command.trim().length === 0 && Object.keys(scripts).length > 0) {
      const firstScript = Object.entries(scripts)[0];
      if (firstScript) {
        setScriptName(firstScript[0]);
        setCommand(firstScript[1]);
      }
    }
  }, [command, scripts, state.command]);

  useEffect(() => {
    previewLoadedRef.current = false;
    setIframeBlocked(false);

    if (!effectivePreviewUrl) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!previewLoadedRef.current) {
        setIframeBlocked(true);
      }
    }, 3000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [effectivePreviewUrl]);

  const scriptOptions = useMemo(
    () => Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)),
    [scripts],
  );

  const isRunningLike = state.status === "running" || state.status === "starting";
  const canStart = !isRunningLike && command.trim().length > 0;
  const canStop = isRunningLike;
  const canRestart = command.trim().length > 0 && state.status !== "starting";

  const handleSelectScript = (name: string) => {
    setScriptName(name);
    const selected = scripts[name];
    if (selected) {
      setCommand(selected);
    }
  };

  const handleStart = async () => {
    if (!canStart) {
      return;
    }
    setActionPending("start");
    try {
      await start({
        command: command.trim(),
        scriptName: scriptName || undefined,
      });
    } finally {
      setActionPending(null);
    }
  };

  const handleStop = async () => {
    if (!canStop) {
      return;
    }
    setActionPending("stop");
    try {
      await stop();
    } finally {
      setActionPending(null);
    }
  };

  const handleRestart = async () => {
    if (!canRestart) {
      return;
    }
    setActionPending("restart");
    try {
      await restart({
        command: command.trim(),
        scriptName: scriptName || undefined,
      });
    } finally {
      setActionPending(null);
    }
  };

  return (
    <div className="dev-server-page" data-testid="dev-server-view">
      <div className="dev-server-header card">
        <div className="dev-server-header-title">
          <Server size={16} />
          <h2>Dev Server</h2>
        </div>
        <div className="dev-server-header-meta">
          <span className={`dev-server-status-badge dev-server-status-badge--${state.status}`}>
            {state.status}
          </span>
          <span className="dev-server-connection-state">stream: {connectionState}</span>
        </div>
      </div>

      <div className="dev-server-layout">
        <section className="dev-server-panel card" aria-label="Dev server controls">
          <div className="dev-server-panel-header">
            <h3>Controls</h3>
            <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </button>
          </div>

          <label className="dev-server-label" htmlFor="dev-server-script">
            Script
          </label>
          <select
            id="dev-server-script"
            className="select"
            value={scriptName}
            onChange={(event) => handleSelectScript(event.target.value)}
          >
            <option value="">Custom command</option>
            {scriptOptions.map(([name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <label className="dev-server-label" htmlFor="dev-server-command">
            Command
          </label>
          <input
            id="dev-server-command"
            className="input"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="pnpm dev"
          />

          <div className="dev-server-actions">
            <button
              className="btn btn-primary"
              onClick={() => void handleStart()}
              disabled={!canStart || actionPending !== null}
              data-testid="dev-server-start-btn"
            >
              <Play size={14} />
              <span>{actionPending === "start" ? "Starting…" : "Start"}</span>
            </button>
            <button
              className="btn btn-warning"
              onClick={() => void handleRestart()}
              disabled={!canRestart || actionPending !== null}
              data-testid="dev-server-restart-btn"
            >
              <RefreshCw size={14} />
              <span>{actionPending === "restart" ? "Restarting…" : "Restart"}</span>
            </button>
            <button
              className="btn btn-danger"
              onClick={() => void handleStop()}
              disabled={!canStop || actionPending !== null}
              data-testid="dev-server-stop-btn"
            >
              <Square size={14} />
              <span>{actionPending === "stop" ? "Stopping…" : "Stop"}</span>
            </button>
          </div>

          <div className="dev-server-meta-grid" data-testid="dev-server-status-panel">
            <div>
              <span className="dev-server-meta-label">PID</span>
              <span className="dev-server-meta-value">{state.pid ?? "—"}</span>
            </div>
            <div>
              <span className="dev-server-meta-label">Started</span>
              <span className="dev-server-meta-value">{formatTimestamp(state.startedAt)}</span>
            </div>
            <div>
              <span className="dev-server-meta-label">Exited</span>
              <span className="dev-server-meta-value">{formatTimestamp(state.exitedAt)}</span>
            </div>
            <div>
              <span className="dev-server-meta-label">Exit Code</span>
              <span className="dev-server-meta-value">{state.exitCode ?? "—"}</span>
            </div>
          </div>

          {error && <p className="dev-server-error">{error}</p>}
          {!error && state.failureReason && <p className="dev-server-error">{state.failureReason}</p>}
        </section>

        <section className="dev-server-panel card" aria-label="Preview" data-testid="dev-server-preview-panel">
          <div className="dev-server-panel-header">
            <h3>Preview</h3>
            {effectivePreviewUrl && (
              <a className="btn btn-sm" href={effectivePreviewUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                <span>Open</span>
              </a>
            )}
          </div>

          <label className="dev-server-label" htmlFor="dev-server-preview-url">
            Preview URL override
          </label>
          <div className="dev-server-preview-input-row">
            <input
              id="dev-server-preview-url"
              className="input"
              value={manualPreviewUrl}
              onChange={(event) => setManualPreviewUrl(event.target.value)}
              placeholder={state.previewUrl ?? "https://localhost:3000"}
              data-testid="dev-server-preview-url-input"
            />
            <button
              className="btn btn-sm"
              onClick={() => setManualPreviewUrl("")}
              disabled={manualPreviewUrl.trim().length === 0}
              data-testid="dev-server-clear-preview-override"
            >
              Clear
            </button>
          </div>

          {!effectivePreviewUrl && (
            <div className="dev-server-preview-empty">Start the server to load a preview.</div>
          )}

          {effectivePreviewUrl && (
            <>
              <iframe
                title="Dev Server Preview"
                src={effectivePreviewUrl}
                className="dev-server-preview-frame"
                onLoad={() => {
                  previewLoadedRef.current = true;
                  setIframeBlocked(false);
                }}
                onError={() => {
                  previewLoadedRef.current = false;
                  setIframeBlocked(true);
                }}
              />
              {iframeBlocked && (
                <div className="dev-server-preview-fallback" data-testid="dev-server-preview-fallback">
                  <p>
                    Preview could not be embedded (the target may block iframes). Use the open button to launch it in a new tab.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <section className="dev-server-panel card" data-testid="dev-server-logs-panel">
        <div className="dev-server-panel-header">
          <h3>Recent logs</h3>
          <span>{logs.length} entries</span>
        </div>
        <div className="dev-server-log-list">
          {logs.length === 0 ? (
            <p className="dev-server-preview-empty">No logs yet.</p>
          ) : (
            logs.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className={`dev-server-log-entry dev-server-log-entry--${entry.source}`}>
                <span className="dev-server-log-time">{formatTimestamp(entry.timestamp)}</span>
                <span className="dev-server-log-source">{entry.source}</span>
                <span className="dev-server-log-message">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
