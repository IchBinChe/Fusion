import { describe, expect, it } from "vitest";
import type { ModelPreset } from "@fusion/core";
import {
  applyPresetToSelection,
  generatePresetId,
  getPresetByName,
  getRecommendedPresetForSize,
  validatePresetId,
} from "./modelPresets";

const presets: ModelPreset[] = [
  {
    id: "budget",
    name: "Budget",
    executorProvider: "openai",
    executorModelId: "gpt-4o-mini",
    validatorProvider: "openai",
    validatorModelId: "gpt-4o-mini",
  },
  {
    id: "complex",
    name: "Complex",
    executorProvider: "anthropic",
    executorModelId: "claude-sonnet-4-5",
  },
];

describe("modelPresets utils", () => {
  it("finds presets by case-insensitive display name", () => {
    expect(getPresetByName(presets, "budget")).toEqual(presets[0]);
    expect(getPresetByName(presets, "  COMPLEX ")).toEqual(presets[1]);
    expect(getPresetByName(presets, "missing")).toBeUndefined();
  });

  it("applies a preset to dropdown selection values", () => {
    expect(applyPresetToSelection(presets[0])).toEqual({
      executorValue: "openai/gpt-4o-mini",
      validatorValue: "openai/gpt-4o-mini",
    });
    expect(applyPresetToSelection(undefined)).toEqual({
      executorValue: "",
      validatorValue: "",
    });
  });

  it("recommends the mapped preset for a task size", () => {
    expect(
      getRecommendedPresetForSize("S", { S: "budget", M: "complex" }, presets),
    ).toEqual(presets[0]);
    expect(
      getRecommendedPresetForSize("L", { S: "budget", M: "complex" }, presets),
    ).toBeUndefined();
    expect(getRecommendedPresetForSize(undefined, { S: "budget" }, presets)).toBeUndefined();
  });

  it("validates preset ids", () => {
    expect(validatePresetId("budget")).toBe(true);
    expect(validatePresetId("budget_v2")).toBe(true);
    expect(validatePresetId("budget-v2")).toBe(true);
    expect(validatePresetId("")).toBe(false);
    expect(validatePresetId("has spaces")).toBe(false);
    expect(validatePresetId("invalid!char")).toBe(false);
    expect(validatePresetId("a".repeat(33))).toBe(false);
  });

  it("generates slug-friendly preset ids", () => {
    expect(generatePresetId("Budget")).toBe("budget");
    expect(generatePresetId("  Normal Mode  ")).toBe("normal-mode");
    expect(generatePresetId("Complex / Reviewer")).toBe("complex-reviewer");
    expect(generatePresetId("!!!")).toBe("preset");
    expect(generatePresetId("a".repeat(40))).toBe("a".repeat(32));
  });
});
