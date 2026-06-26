import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { DevServerView } from "../DevServerView";

const mockUseDevServer = vi.fn();
const mockUseDevServerLogs = vi.fn();
const mockUsePreviewEmbed = vi.fn();

vi.mock("../../hooks/useDevServer", () => ({
  useDevServer: (...args: unknown[]) => mockUseDevServer(...args),
}));

vi.mock("../../hooks/useDevServerLogs", () => ({
  useDevServerLogs: (...args: unknown[]) => mockUseDevServerLogs(...args),
}));

vi.mock("../../hooks/usePreviewEmbed", () => ({
  usePreviewEmbed: (...args: unknown[]) => mockUsePreviewEmbed(...args),
}));

vi.mock("../DevServerLogViewer", () => ({
  DevServerLogViewer: () => <div data-testid="mock-devserver-log-viewer" />,
}));

function extractAtRuleBlocks(css: string, marker: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < css.length) {
    const start = css.indexOf(marker, searchFrom);
    if (start === -1) break;
    const open = css.indexOf("{", start);
    if (open === -1) break;

    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth++;
      else if (css[cursor] === "}") depth--;
      cursor++;
    }

    blocks.push(css.slice(open + 1, cursor - 1));
    searchFrom = cursor;
  }

  return blocks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorRule(css: string, selector: string): string | null {
  const escapedSelector = escapeRegExp(selector);
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, "m"));
  return match?.[0] ?? null;
}

function countSelectorRules(css: string, selector: string): number {
  const escapedSelector = escapeRegExp(selector);
  return (css.match(new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{`, "g")) ?? []).length;
}

function createDevServerHookState() {
  return {
    session: {
      config: { id: "default", name: "Dev Server", command: "pnpm dev", cwd: "." },
      status: "running",
      previewUrl: "http://localhost:3000",
      logHistory: [],
    },
    sessions: [],
    detectedCommands: [],
    previewUrl: "http://localhost:3000",
    isLoading: false,
    error: null,
    startServer: vi.fn().mockResolvedValue(undefined),
    stopServer: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    setPreviewUrl: vi.fn().mockResolvedValue(undefined),
    detectCommands: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe("DevServerView mobile CSS/structure", () => {
  it("defines one mobile rule-set for preview header/actions and wraps badge correctly", () => {
    const css = loadAllAppCss();
    /*
    FNXC:DashboardTests 2026-06-26-13:05:
    DevServerView intentionally keeps preview-header and modal-launcher copy mobile wrapping in separate rules so each surface can be asserted directly. Extract the balanced viewport at-rule from the loaded app CSS instead of counting a stale grouped selector that drifted after the CSS was split.
    */
    const mobileCss = extractAtRuleBlocks(css, "@media (max-width: 768px)")
      .find((block) => block.includes(".devserver-preview-header") && block.includes(".devserver-preview-modal-launcher__copy"));

    expect(mobileCss).toBeTruthy();
    expect(countSelectorRules(mobileCss ?? "", ".devserver-preview-header")).toBe(1);
    expect(selectorRule(mobileCss ?? "", ".devserver-preview-header")).toMatch(/flex-wrap:\s*wrap/);
    expect(countSelectorRules(mobileCss ?? "", ".devserver-preview-modal-launcher__copy")).toBe(1);
    expect(selectorRule(mobileCss ?? "", ".devserver-preview-modal-launcher__copy")).toMatch(/flex-wrap:\s*wrap/);
    expect(selectorRule(mobileCss ?? "", ".devserver-preview-url-badge")).toMatch(/max-width:\s*100%/);
    expect(selectorRule(mobileCss ?? "", ".dev-server-header-title")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("defines narrow right-dock launcher and modal rules without duplicating mobile media rules", () => {
    const css = loadAllAppCss();
    const containerCss = extractAtRuleBlocks(css, "@container right-dock-body (max-width: 768px)")[0];
    expect(containerCss).toBeTruthy();

    expect(containerCss ?? "").toMatch(/\.devserver-preview-panel,\s*\.devserver-preview-modal-launcher\s*\{[\s\S]*grid-column:\s*auto/);
    expect(containerCss ?? "").toMatch(/\.devserver-preview-modal\s*\{[\s\S]*width:\s*min\(calc\(var\(--space-2xl\) \* 20\), calc\(100vw - var\(--space-md\) \* 2\)\)/);
    expect(containerCss ?? "").toMatch(/\.devserver-preview-panel \.devserver-preview-container/);
    expect(containerCss ?? "").not.toMatch(/\.dev-server-logs,\s*\.devserver-preview-container,\s*\.devserver-preview-iframe/);

    expect(css).toMatch(/@media[^{]*\(max-width: 768px\)/);
    expect(css).toMatch(/@container right-dock-body \(max-width: 768px\)/);
  });

  it("renders preview header elements and keeps URL badge outside preview actions", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState());
    mockUseDevServerLogs.mockReturnValue({
      entries: [],
      loading: false,
      loadingMore: false,
      hasMore: false,
      total: 0,
      loadMore: vi.fn(),
    });
    mockUsePreviewEmbed.mockReturnValue({
      embedStatus: "embedded",
      setEmbedStatus: vi.fn(),
      resetEmbedStatus: vi.fn(),
      iframeRef: { current: null },
      isEmbedded: true,
      isBlocked: false,
      blockReason: null,
      retry: vi.fn(),
    });

    render(<DevServerView addToast={vi.fn()} projectId="project-a" />);

    const previewPanel = screen.getByTestId("devserver-preview-panel");
    const badge = screen.getByTestId("devserver-preview-url-badge");
    const actions = previewPanel.querySelector(".devserver-preview-actions");
    const statusBadge = screen.getByTestId("dev-server-status-badge");

    expect(previewPanel.querySelector(".devserver-preview-header")).toBeInTheDocument();
    expect(statusBadge).toBeInTheDocument();
    expect(actions).toBeTruthy();
    expect(actions?.contains(badge)).toBe(false);
    expect(badge.parentElement).toBe(previewPanel.querySelector(".devserver-preview-header"));
  });
});
