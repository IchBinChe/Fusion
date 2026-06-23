import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { MailboxMessageContent } from "../MailboxMessageContent";

// FNXC:Markdown 2026-06-23-03:15: Mock the heavy `mermaid` library so the mermaid
// rendering tests do not pull in the real parser/renderer bundle. The component
// lazy-imports `mermaid` (default export), so we mock the module default.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mock-mermaid-svg'></svg>" }),
  },
}));

afterEach(() => {
  cleanup();
});

describe("MailboxMessageContent", () => {
  it("renders plain-text messages unchanged", () => {
    render(<MailboxMessageContent content="Hello, this is plain text." />);
    expect(screen.getByText("Hello, this is plain text.")).toBeInTheDocument();
  });

  it("renders headings as semantic heading elements", () => {
    render(<MailboxMessageContent content={"# Status Update\n\nDetails below."} />);
    const heading = screen.getByRole("heading", { level: 1, name: "Status Update" });
    expect(heading).toBeInTheDocument();
  });

  it("renders bold and italic emphasis", () => {
    const { container } = render(
      <MailboxMessageContent content="This is **bold** and *italic*." />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
  });

  it("renders unordered lists", () => {
    render(<MailboxMessageContent content={"- one\n- two\n- three"} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toBe("one");
  });

  it("renders inline code with code element", () => {
    const { container } = render(
      <MailboxMessageContent content="Run `pnpm test` to verify." />,
    );
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("pnpm test");
  });

  it("renders fenced code blocks inside the markdown <pre> wrapper", () => {
    const content = "```\nnpm install\n```";
    const { container } = render(<MailboxMessageContent content={content} />);
    const pre = container.querySelector("pre.mailbox-markdown-pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("npm install");
  });

  it("renders links with target=_blank and noopener noreferrer", () => {
    render(
      <MailboxMessageContent content="See [docs](https://example.com/docs)." />,
    );
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders GFM tables with the mailbox-scoped class", () => {
    const content = ["| col a | col b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const { container } = render(<MailboxMessageContent content={content} />);
    const table = container.querySelector("table.mailbox-markdown-table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody td")).toHaveLength(2);
  });

  it("sanitizes raw <script> out of messages (no execution, no element)", () => {
    const content = "<script>window.__pwned = true;</script>Hello";
    const { container } = render(<MailboxMessageContent content={content} />);
    // rehype-raw parses HTML, but rehype-sanitize strips <script> before render.
    expect(container.querySelector("script")).toBeNull();
    expect(
      (globalThis as unknown as { __pwned?: boolean }).__pwned,
    ).toBeUndefined();
    expect(container.textContent).toContain("Hello");
  });

  it("renders raw <details>/<summary> as a working disclosure element", () => {
    const content =
      "<details><summary>More info</summary>Hidden body text here.</details>";
    const { container } = render(<MailboxMessageContent content={content} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe("More info");
    expect(details?.textContent).toContain("Hidden body text here.");
  });

  it("renders other safe raw HTML (kbd/sub) as real elements", () => {
    const content = "Press <kbd>Cmd</kbd> and H<sub>2</sub>O.";
    const { container } = render(<MailboxMessageContent content={content} />);
    expect(container.querySelector("kbd")?.textContent).toBe("Cmd");
    expect(container.querySelector("sub")?.textContent).toBe("2");
  });

  it("does NOT render HTML comments in the output", () => {
    const content = "Before<!-- secret hidden note -->After";
    const { container } = render(<MailboxMessageContent content={content} />);
    expect(container.innerHTML).not.toContain("secret hidden note");
    expect(container.innerHTML).not.toContain("<!--");
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
  });

  it("strips javascript: URLs and event handlers from raw HTML", () => {
    const content = '<a href="javascript:alert(1)" onclick="alert(2)">click</a>';
    const { container } = render(<MailboxMessageContent content={content} />);
    const link = container.querySelector("a");
    // sanitize drops the javascript: href and the onclick handler.
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
    expect(link?.getAttribute("onclick")).toBeNull();
  });

  it("renders a ```mermaid block as the MermaidDiagram container", async () => {
    const content = "```mermaid\ngraph TD; A-->B;\n```";
    render(<MailboxMessageContent content={content} />);
    const diagram = await screen.findByTestId("mailbox-mermaid-diagram");
    expect(diagram).toBeInTheDocument();
    expect(diagram).toHaveClass("mailbox-mermaid");
    // The mocked mermaid.render SVG is injected into the container.
    await waitFor(() => {
      expect(diagram.querySelector("svg")).not.toBeNull();
    });
  });

  it("forwards testId to the wrapper", () => {
    render(<MailboxMessageContent content="x" testId="mailbox-message-body" />);
    expect(screen.getByTestId("mailbox-message-body")).toBeInTheDocument();
  });

  describe("file-path linkification", () => {
    it("renders prose file paths as clickable file-path-link buttons", () => {
      render(
        <FileBrowserProvider openFile={vi.fn()}>
          <MailboxMessageContent content="See packages/dashboard/app/App.tsx for context." />
        </FileBrowserProvider>,
      );

      expect(
        screen.getByRole("button", { name: "packages/dashboard/app/App.tsx" }),
      ).toHaveClass("file-path-link");
    });

    it("opens the linked file with parsed line and column", async () => {
      const openFile = vi.fn();
      render(
        <FileBrowserProvider openFile={openFile}>
          <MailboxMessageContent content="Review packages/dashboard/app/App.tsx:12:3 before shipping." />
        </FileBrowserProvider>,
      );

      await userEvent.click(
        screen.getByRole("button", { name: "packages/dashboard/app/App.tsx:12:3" }),
      );

      expect(openFile).toHaveBeenCalledWith("packages/dashboard/app/App.tsx", { line: 12, col: 3 });
    });

    it("does not linkify paths inside fenced code blocks", () => {
      render(
        <FileBrowserProvider openFile={vi.fn()}>
          <MailboxMessageContent content={"```\npackages/dashboard/app/App.tsx:44\n```"} />
        </FileBrowserProvider>,
      );

      expect(screen.queryByRole("button", { name: "packages/dashboard/app/App.tsx:44" })).toBeNull();
    });
  });
});
