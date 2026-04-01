import { useState, useEffect, useCallback } from "react";
import { FileCode, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import { fetchTaskDiff, type TaskDiff } from "../api";

interface TaskChangesTabProps {
  taskId: string;
  worktree?: string;
}

function getFileStatus(file: string, patch: string): "added" | "modified" | "deleted" | "unknown" {
  if (patch.includes("diff --git")) {
    if (patch.includes("new file mode")) return "added";
    if (patch.includes("deleted file mode")) return "deleted";
    return "modified";
  }
  return "unknown";
}

function getStatusColor(status: "added" | "modified" | "deleted" | "unknown"): string {
  switch (status) {
    case "added":
      return "#3fb950"; // green
    case "deleted":
      return "#f85149"; // red
    case "modified":
      return "#58a6ff"; // blue
    default:
      return "#8b949e"; // gray
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskChangesTab({ taskId, worktree }: TaskChangesTabProps) {
  const [diffData, setDiffData] = useState<TaskDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const loadDiff = useCallback(async () => {
    if (!worktree) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await fetchTaskDiff(taskId);
      setDiffData(data);
      // Auto-expand first file if there are files
      if (data.files.length > 0) {
        setExpandedFiles(new Set([data.files[0]]));
      }
    } catch (err: any) {
      setError(err.message || "Failed to load diff");
    } finally {
      setLoading(false);
    }
  }, [taskId, worktree]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="detail-section">
        <div className="detail-loading">
          <div className="loading-spinner" />
          <span>Loading changes...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-section">
        <div className="detail-error">
          <AlertCircle size={16} />
          <span>Error loading changes: {error}</span>
        </div>
      </div>
    );
  }

  if (!worktree) {
    return (
      <div className="detail-section">
        <div className="detail-empty-state">
          <FileCode size={24} />
          <p>No worktree available for this task.</p>
          <span className="detail-empty-hint">
            Changes will be shown once the task is in progress.
          </span>
        </div>
      </div>
    );
  }

  if (!diffData || diffData.files.length === 0) {
    return (
      <div className="detail-section">
        <div className="detail-empty-state">
          <FileCode size={24} />
          <p>No files modified.</p>
          <span className="detail-empty-hint">
            The agent did not modify any files during execution.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-section task-changes-tab">
      <div className="changes-header">
        <h4>
          <FileCode size={16} />
          Modified Files ({diffData.files.length})
        </h4>
        <button
          className="btn btn-sm"
          onClick={loadDiff}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      <div className="changes-file-list">
        {diffData.files.map((file) => {
          const fileDiff = diffData.diffs[file];
          const status = getFileStatus(file, fileDiff?.patch || "");
          const isExpanded = expandedFiles.has(file);

          return (
            <div
              key={file}
              className={`changes-file-item ${isExpanded ? "expanded" : ""}`}
            >
              <button
                className="changes-file-header"
                onClick={() => toggleFile(file)}
              >
                <span className="changes-file-toggle">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span
                  className="changes-file-status"
                  style={{ color: getStatusColor(status) }}
                  title={status}
                >
                  {status === "added" && "A"}
                  {status === "modified" && "M"}
                  {status === "deleted" && "D"}
                  {status === "unknown" && "?"}
                </span>
                <span className="changes-file-path" title={file}>
                  {file}
                </span>
                {fileDiff?.stat && (
                  <span className="changes-file-stat" title={fileDiff.stat}>
                    {fileDiff.stat}
                  </span>
                )}
              </button>

              {isExpanded && fileDiff?.patch && (
                <div className="changes-file-content">
                  <pre className="changes-diff-patch">
                    <code>{fileDiff.patch}</code>
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
