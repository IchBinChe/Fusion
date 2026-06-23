import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { DockFilesView } from "../DockFilesView";
import { getScopedItem, scopedKey } from "../../utils/projectStorage";
import type { FileNode } from "../../api";

/*
FNXC:RightDockFiles 2026-06-22-23:30:
Proves the current-file path is shared between the dock instance and the popped-out (expand) instance via scoped storage: selecting a file in the dock persists it, and a freshly mounted expand instance reads it on mount and opens the SAME file in its viewer pane.
*/

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const entries: FileNode[] = [
  { name: "readme.md", type: "file", size: 10, mtime: "2026-01-15T10:30:00Z" },
];

const dockFilesCss = readFileSync(resolve(__dirname, "../DockFilesView.css"), "utf8");

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({
    entries,
    currentPath: "",
    setPath: vi.fn(),
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const mockFetchContent = vi.fn(() => Promise.resolve({ content: "# hi" }));
const mockSaveContent = vi.fn(() => Promise.resolve({ mtime: "2026-01-15T10:31:00Z" }));
vi.mock("../../api", () => ({
  fetchWorkspaceFileContent: (...args: unknown[]) => mockFetchContent(...(args as [])),
  saveWorkspaceFileContent: (...args: unknown[]) => mockSaveContent(...(args as [])),
}));

const capturedFileEditorProps: Array<{
  filePath?: string;
  toolbarExpanded?: boolean;
  forceToolbarActionsVisible?: boolean;
  showLineNumbers?: boolean;
  onToggleLineNumbers?: () => void;
  readOnly?: boolean;
}> = [];

// Keep the viewer simple: surface the file path it was asked to render and capture toolbar props.
vi.mock("../FileEditor", () => ({
  FileEditor: (props: {
    filePath?: string;
    toolbarExpanded?: boolean;
    forceToolbarActionsVisible?: boolean;
    showLineNumbers?: boolean;
    onToggleLineNumbers?: () => void;
    readOnly?: boolean;
  }) => {
    capturedFileEditorProps.push(props);
    return <div data-testid="mock-file-editor" data-file-path={props.filePath} />;
  },
}));

// Render the tree's files as buttons so we can click one.
vi.mock("../FileBrowser", () => ({
  FileBrowser: ({ entries: e, onSelectFile }: { entries: FileNode[]; onSelectFile: (p: string) => void }) => (
    <div data-testid="mock-file-browser">
      {e.map((entry) => (
        <button key={entry.name} type="button" onClick={() => onSelectFile(entry.name)}>
          {entry.name}
        </button>
      ))}
    </div>
  ),
}));

const PROJECT_ID = "proj-1";
const KEY = scopedKey("kb-dashboard-dock-files-current", PROJECT_ID);

describe("DockFilesView shared current-file state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockFetchContent.mockClear();
    mockSaveContent.mockClear();
    capturedFileEditorProps.length = 0;
  });
  afterEach(() => cleanup());

  it("keeps right-dock Files view dividers tokenized and invisible by default", () => {
    /*
    FNXC:RightDockChrome 2026-06-23-19:10:
    The default Files dock view must not draw extra header or pane dividers unless a theme opts into the right-dock divider token.
    */
    expect(dockFilesCss).toContain("border-bottom: var(--chrome-divider-width, 1px) solid var(--right-dock-view-divider-color, transparent);");
    expect(dockFilesCss).toContain("border-right: var(--chrome-divider-width, 1px) solid var(--right-dock-view-divider-color, transparent);");
    expect(dockFilesCss).not.toContain("border-bottom: 1px solid var(--border);");
    expect(dockFilesCss).not.toContain("border-right: 1px solid var(--border);");
  });

  it("persists the selected file to scoped storage and a fresh expand instance reads it on mount", async () => {
    // 1. Dock instance: select a file.
    const dock = render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));

    // The path was persisted to the shared scoped key.
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBe("readme.md");
    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });

    // 2. Unmount the dock; mount a SEPARATE expand instance (two-pane pop-out).
    dock.unmount();
    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);

    // The expand instance opened the SAME file from storage on mount.
    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });
    expect(screen.queryByTestId("right-dock-files-empty")).toBeNull();
    expect(screen.getByTestId("right-dock-files-view")).toHaveAttribute("data-layout", "two-pane");
  });

  it("clearing the file (back) clears the shared key", () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBe("readme.md");

    fireEvent.click(screen.getByTestId("right-dock-files-back"));
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBeNull();
    expect(screen.getByTestId("right-dock-files-empty")).toBeInTheDocument();
  });

  it("live-syncs from a cross-instance storage event", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);
    expect(screen.getByTestId("right-dock-files-empty")).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem(KEY, "readme.md");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "readme.md" }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });
  });

  it("uses the full modal/mobile file editor toolbar in the right dock viewer", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));

    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });

    const latest = capturedFileEditorProps.at(-1);
    expect(latest).toMatchObject({
      filePath: "readme.md",
      toolbarExpanded: true,
      forceToolbarActionsVisible: true,
      showLineNumbers: true,
    });
    expect(latest?.readOnly).toBeFalsy();
    expect(latest?.onToggleLineNumbers).toEqual(expect.any(Function));
    expect(screen.getByTestId("right-dock-files-save")).toBeDisabled();
  });
});
