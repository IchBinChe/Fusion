import { describe, expect, it } from "vitest";

import { NativeSandboxBackend } from "../native.js";
import { resolveSandboxBackend } from "../index.js";

describe("resolveSandboxBackend", () => {
  it("returns native for undefined backend", () => {
    expect(resolveSandboxBackend()).toBeInstanceOf(NativeSandboxBackend);
  });

  it("returns native for explicit native backend", () => {
    expect(resolveSandboxBackend({ backendId: "native" })).toBeInstanceOf(NativeSandboxBackend);
  });

  it("returns native for unknown backend id", () => {
    expect(resolveSandboxBackend({ backendId: "bubblewrap" })).toBeInstanceOf(NativeSandboxBackend);
  });
});
