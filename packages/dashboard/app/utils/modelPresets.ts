import type { ModelPreset } from "@fusion/core";

export function getPresetByName(presets: ModelPreset[], name: string): ModelPreset | undefined {
  const normalizedName = name.trim().toLowerCase();
  return presets.find((preset) => preset.name.trim().toLowerCase() === normalizedName);
}

export function applyPresetToSelection(preset: ModelPreset | undefined): {
  executorValue: string;
  validatorValue: string;
} {
  return {
    executorValue: preset?.executorProvider && preset?.executorModelId
      ? `${preset.executorProvider}/${preset.executorModelId}`
      : "",
    validatorValue: preset?.validatorProvider && preset?.validatorModelId
      ? `${preset.validatorProvider}/${preset.validatorModelId}`
      : "",
  };
}

export function getRecommendedPresetForSize(
  size: "S" | "M" | "L" | undefined,
  defaultPresetBySize: Record<string, string>,
  presets: ModelPreset[],
): ModelPreset | undefined {
  if (!size) return undefined;
  const presetId = defaultPresetBySize[size];
  if (!presetId) return undefined;
  return presets.find((preset) => preset.id === presetId);
}

export function validatePresetId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

export function generatePresetId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);

  return slug || "preset";
}
