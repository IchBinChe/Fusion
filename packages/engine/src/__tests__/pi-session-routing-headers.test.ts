import { describe, it, expect } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { attachSessionRoutingHeaders, buildSessionRoutingHeaders } from "../pi.js";

// FNXC:SessionRouting 2026-06-23-16:40:
// Issue #1675: chat completion requests must carry X-Session-Id and
// X-Session-Affinity so LLM gateways can sticky-route and observability tools
// can group the stateless API calls of one conversation into a single trace.

describe("buildSessionRoutingHeaders", () => {
  it("emits X-Session-Id and X-Session-Affinity with the same identifier", () => {
    expect(buildSessionRoutingHeaders("sess-123")).toEqual({
      "X-Session-Id": "sess-123",
      "X-Session-Affinity": "sess-123",
    });
  });
});

describe("attachSessionRoutingHeaders", () => {
  // Minimal stand-in for the bits of ModelRegistry the wrapper touches.
  function makeRegistry(
    resolve: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>,
  ): ModelRegistry {
    return { getApiKeyAndHeaders: resolve } as unknown as ModelRegistry;
  }

  const anyModel = { provider: "anthropic", id: "claude" } as never;

  it("merges the routing headers into resolved request headers", async () => {
    const registry = makeRegistry(async () => ({ ok: true, apiKey: "sk-live", headers: undefined }));
    attachSessionRoutingHeaders(registry, "sess-abc");

    const result = await registry.getApiKeyAndHeaders(anyModel);

    expect(result).toEqual({
      ok: true,
      apiKey: "sk-live",
      headers: {
        "X-Session-Id": "sess-abc",
        "X-Session-Affinity": "sess-abc",
      },
    });
  });

  it("preserves the resolved apiKey and any provider-specific headers", async () => {
    const registry = makeRegistry(async () => ({
      ok: true,
      apiKey: "sk-custom",
      headers: { "HTTP-Referer": "https://example.com", "X-Title": "Fusion" },
    }));
    attachSessionRoutingHeaders(registry, "sess-xyz");

    const result = await registry.getApiKeyAndHeaders(anyModel);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok auth result");
    expect(result.apiKey).toBe("sk-custom");
    expect(result.headers).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": "Fusion",
      "X-Session-Id": "sess-xyz",
      "X-Session-Affinity": "sess-xyz",
    });
  });

  it("does not alter failed auth resolutions", async () => {
    const registry = makeRegistry(async () => ({ ok: false, error: "No API key found" }));
    attachSessionRoutingHeaders(registry, "sess-fail");

    const result = await registry.getApiKeyAndHeaders(anyModel);

    expect(result).toEqual({ ok: false, error: "No API key found" });
  });

  it("no-ops without throwing when getApiKeyAndHeaders is absent", () => {
    // If a future pi-coding-agent rename removes the method, the wrapper must not
    // break session creation. It leaves the registry untouched and warns instead.
    const registry = {} as ModelRegistry;

    expect(() => attachSessionRoutingHeaders(registry, "sess-none")).not.toThrow();
    expect((registry as unknown as Record<string, unknown>).getApiKeyAndHeaders).toBeUndefined();
  });
});
