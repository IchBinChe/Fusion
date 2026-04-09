import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserModal } from "./FileBrowserModal";
import * as workspaceBrowserHook from "../hooks/useWorkspaceFileBrowser";
import * as workspaceEditorHook from "../hooks/useWorkspaceFileEditor";
import * as workspacesHook from "../hooks/useWorkspaces";

vi.mock("../hooks/useWorkspaceFileBrowser");
vi.mock("../hooks/useWorkspaceFileEditor");
vi.mock("../hooks/useWorkspaces");

const mockUseWorkspaceFileBrowser = vi.mocked(workspaceBrowserHook.useWorkspaceFileBrowser);
const mockUseWorkspaceFileEditor = vi.mocked(workspaceEditorHook.useWorkspaceFileEditor);
const mockUseWorkspaces = vi.mocked(workspacesHook.useWorkspaces);

describe("FileBrowserModal", () => {
  const mockOnClose = vi.fn();
  const mockOnWorkspaceChange = vi.fn();
  const mockSave = vi.fn().mockResolvedValue(undefined);
  const mockSetContent = vi.fn();
  const mockSetPath = vi.fn();
  const mockRefresh = vi.fn();

  const defaultBrowserState = {
    entries: [
      { name: "file1.ts", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      { name: "folder1", type: "directory" as const, mtime: "2024-01-01" },
    ],
    currentPath: ".",
    setPath: mockSetPath,
    loading: false,
    error: null,
    refresh: mockRefresh,
  };

  const defaultEditorState = {
    content: "console.log('hello');",
    setContent: mockSetContent,
    originalContent: "console.log('hello');",
    loading: false,
    saving: false,
    error: null,
    save: mockSave,
    hasChanges: false,
    mtime: "2024-01-01",
  };

  beforeEach(() => {
    vi.resetAllMocks();

    mockUseWorkspaceFileBrowser.mockReturnValue(defaultBrowserState);
    mockUseWorkspaceFileEditor.mockReturnValue(defaultEditorState);
    mockUseWorkspaces.mockReturnValue({
      projectName: "kb",
      workspaces: [
        { id: "FN-001", label: "FN-001", title: "Task One", worktree: "/repo/.worktrees/kb-001", kind: "task" },
        { id: "FN-002", label: "FN-002", title: "Task Two", worktree: "/repo/.worktrees/kb-002", kind: "task" },
      ],
      loading: false,
      error: null,
    });

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders project-root modal title and workspace selector", () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    expect(screen.getByText("Files — Project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /kb/i })).toBeInTheDocument();
    expect(mockUseWorkspaceFileBrowser).toHaveBeenCalledWith("project", true);
  });

  it("opens a file in the editor when selected", async () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByText("file1.ts"));

    await waitFor(() => {
      expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument();
    });

    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "file1.ts", true);
  });

  it("switches workspace and notifies parent", async () => {
    const user = userEvent.setup();
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    expect(mockOnWorkspaceChange).toHaveBeenCalledWith("FN-002");
  });

  it("shows back button in mobile editor view", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));
    fireEvent.click(screen.getByText("file1.ts"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
    });
  });

  it("keeps mobile close button visible and clickable", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    const { container } = render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    const closeButton = container.querySelector("button.modal-close");
    expect(closeButton).toBeInTheDocument();
    expect(closeButton).toBeVisible();

    fireEvent.click(closeButton!);
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it("close button is visible on mobile after selecting a file with a long path", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    // Provide a file with a long path name
    const longFileName = "packages/dashboard/app/components/SomeVeryLongComponentName.tsx";
    mockUseWorkspaceFileBrowser.mockReturnValue({
      ...defaultBrowserState,
      entries: [
        { name: longFileName, type: "file" as const, size: 2048, mtime: "2024-01-01" },
      ],
    });

    const { container } = render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    // Select the long-named file
    fireEvent.click(screen.getByText(longFileName));

    // Verify the file path appears in the header
    await waitFor(() => {
      const pathEl = container.querySelector(".file-browser-header-path");
      expect(pathEl).toBeInTheDocument();
      expect(pathEl?.textContent).toBe(longFileName);
    });

    const closeButton = container.querySelector("button.modal-close");
    expect(closeButton).toBeInTheDocument();
    expect(closeButton).toBeVisible();

    // Clicking the close button should trigger onClose
    fireEvent.click(closeButton!);
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it("long file path is truncated on mobile", async () => {
    // Read CSS file directly to verify the overflow/ellipsis rules
    // (JSDOM doesn't apply stylesheets, so computed style checks won't work)
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const cssPath = resolve(__dirname, "../styles.css");
    const cssContent = readFileSync(cssPath, "utf-8");

    // Extract mobile media query blocks
    function extractMobileMediaBlocks(content: string): string {
      const blocks: string[] = [];
      const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
      let match;

      while ((match = regex.exec(content)) !== null) {
        const startIdx = match.index + match[0].length;
        let braceCount = 1;
        let endIdx = startIdx;

        while (braceCount > 0 && endIdx < content.length) {
          if (content[endIdx] === "{") braceCount += 1;
          if (content[endIdx] === "}") braceCount -= 1;
          endIdx += 1;
        }

        if (braceCount === 0) {
          blocks.push(content.slice(startIdx, endIdx - 1));
        }
      }

      return blocks.join("\n");
    }

    const mobileBlock = extractMobileMediaBlocks(cssContent);

    // Find the file-browser-header-path rule within mobile blocks
    const pathMatch = mobileBlock.match(
      /\.file-browser-header-path\s*\{([^}]*)\}/,
    );
    expect(pathMatch).not.toBeNull();

    const pathRules = pathMatch![1];
    expect(pathRules).toContain("text-overflow: ellipsis");
    expect(pathRules).toContain("white-space: nowrap");
    expect(pathRules).toContain("overflow: hidden");
    expect(pathRules).toContain("max-width: 50vw");
  });

  it("closes on Escape and saves on Cmd+S", () => {
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      hasChanges: true,
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "s", metaKey: true });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("renders hidden files and directories from the file listing", () => {
    mockUseWorkspaceFileBrowser.mockReturnValue({
      ...defaultBrowserState,
      entries: [
        { name: ".env.example", type: "file", size: 42, mtime: "2024-01-01" },
        { name: ".github", type: "directory", mtime: "2024-01-01" },
        { name: "src", type: "directory", mtime: "2024-01-01" },
      ],
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByText(".env.example")).toBeInTheDocument();
    expect(screen.getByText(".github")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });
});
