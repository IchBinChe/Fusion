import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("bin pr router wiring", () => {
  const source = readFileSync(resolve(__dirname, "../bin.ts"), "utf8");

  it("includes top-level pr create router", () => {
    expect(source).toContain('case "pr":');
    expect(source).toContain('case "create":');
    expect(source).toContain("runTaskPrCreate(id, parsePrCreateOptions(args.slice(3)), projectName)");
  });

  it("parses draft/no-ai/reviewer flags for pr-create aliases", () => {
    expect(source).toContain('const draft = args.includes("--draft")');
    expect(source).toContain('const ai = !args.includes("--no-ai")');
    expect(source).toContain('args[i] === "--reviewer"');
    expect(source).toContain('case "pr-create":');
  });
});
