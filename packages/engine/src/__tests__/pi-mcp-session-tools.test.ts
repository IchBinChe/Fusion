import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const piSource = () => readFileSync(join(process.cwd(), "src/pi.ts"), "utf8");

describe("pi MCP session tool integration", () => {
  it("registers MCP tools through customTools instead of passing mcpServers to pi", () => {
    const source = piSource();
    expect(source).toContain("connectMcpSessionTools(forwardedMcpServers");
    expect(source).toContain("...(mcpToolset?.tools ?? [])");
    expect(source).toContain("wrapToolsWithActionGate(");
    expect(source).toContain("wrapToolsWithBoundary(");
    expect(source).not.toContain("mcpServers: forwardedMcpServers");
  });

  it("skips MCP servers in readonly sessions and chains disposal into session dispose", () => {
    const source = piSource();
    expect(source).toContain("forwardedMcpServers.length > 0 && !isReadonly");
    expect(source).toContain("readonly session — MCP servers");
    expect(source).toContain("await mcpToolset.dispose()");
    expect(source).toContain("await mcpToolset?.dispose()");
  });
});
