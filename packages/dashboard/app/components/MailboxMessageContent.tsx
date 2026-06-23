import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import { linkifyReactChildren } from "../utils/filePathLinkify";
import { sharedRehypePlugins, createMermaidCodeComponent } from "./markdownPipeline";

/*
FNXC:Markdown 2026-06-23-03:30:
The sanitize schema, rehype plugin chain (rehype-raw -> rehype-sanitize), and the
mermaid-aware code component now live in ./markdownPipeline so the task
description + summary in TaskDetailModal share the exact same XSS posture. This
component consumes those shared exports; see markdownPipeline.tsx for the rationale.
*/

const mailboxMarkdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  pre: ({ children, ...props }) => (
    <pre {...props} className="mailbox-markdown-pre">
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <table {...props} className="mailbox-markdown-table">
      {children}
    </table>
  ),
  // Code-block override: fenced ```mermaid renders as a diagram; all other code
  // keeps default rendering. See createMermaidCodeComponent in markdownPipeline.
  code: createMermaidCodeComponent("mailbox-mermaid-diagram"),
  // Open links in a new tab. Sanitize strips javascript: URLs and event handlers
  // before this runs, so href is safe.
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const remarkPlugins: PluggableList = [remarkGfm];

interface MailboxMessageContentProps {
  /** Raw message body. Rendered as GitHub-flavored markdown. */
  content: string;
  /** Optional extra class for the wrapper. */
  className?: string;
  /** Optional data-testid for test selectors. */
  testId?: string;
}

/**
 * Renders a mailbox message body as GitHub-flavored markdown.
 *
 * Supports embedded raw HTML (details/summary/kbd/sub/tables) via rehype-raw, with
 * rehype-sanitize stripping XSS (script/style/iframe/event-handlers/javascript:).
 * Fenced ```mermaid blocks render as diagrams via the lazy-loaded MermaidDiagram.
 * HTML comments (`<!-- -->`) are dropped and never rendered.
 *
 * Memoized because mailbox detail panes can re-render on selection / SSE
 * updates while the underlying message body is unchanged.
 */
export const MailboxMessageContent = memo(function MailboxMessageContent({
  content,
  className,
  testId,
}: MailboxMessageContentProps) {
  const wrapperClass = className
    ? `mailbox-markdown ${className}`
    : "mailbox-markdown";
  return (
    <div className={wrapperClass} data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={sharedRehypePlugins}
        components={mailboxMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
