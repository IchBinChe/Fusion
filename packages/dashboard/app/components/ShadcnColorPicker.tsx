import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SHADCN_CUSTOM_COLOR_TOKENS,
  getShadcnCustomDefaultValue,
  sanitizeShadcnCustomColors,
} from "./shadcnCustomColors";
import "./ShadcnColorPicker.css";

export interface ShadcnColorPickerProps {
  value?: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  resolvedThemeMode?: "dark" | "light";
}

function toColorInputValue(value: string): string {
  const trimmed = value.trim();
  if (/^#[\da-f]{6}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^#[\da-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#000000";
}

/*
FNXC:Theme 2026-06-20-18:38:
The shadcn custom picker is shared by Settings and Command Center; it only edits the sanitized token→hex override map while the parent surfaces decide visibility for shadcn-custom so no other theme receives inline overrides.
*/
export function ShadcnColorPicker({
  value = {},
  onChange,
  resolvedThemeMode = "dark",
}: ShadcnColorPickerProps) {
  const { t } = useTranslation("app");
  const sanitizedValue = useMemo(() => sanitizeShadcnCustomColors(value), [value]);

  const updateToken = (cssVar: string, nextValue: string) => {
    onChange(sanitizeShadcnCustomColors({ ...sanitizedValue, [cssVar]: nextValue }));
  };

  return (
    <section className="shadcn-color-picker card" data-testid="shadcn-color-picker" aria-labelledby="shadcn-color-picker-title">
      <div className="shadcn-color-picker-header">
        <div>
          <h3 id="shadcn-color-picker-title" className="shadcn-color-picker-title">
            {t("theme.shadcnCustom.title", "Custom shadcn colors")}
          </h3>
          <p className="shadcn-color-picker-description">
            {t("theme.shadcnCustom.description", "Override shadcn design tokens with hex colors. Blank tokens use the theme defaults.")}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => onChange({})}>
          {t("theme.shadcnCustom.reset", "Reset custom colors")}
        </button>
      </div>
      <div className="shadcn-color-picker-grid">
        {SHADCN_CUSTOM_COLOR_TOKENS.map((token) => {
          const fallback = getShadcnCustomDefaultValue(token, resolvedThemeMode);
          const currentValue = sanitizedValue[token.cssVar] ?? fallback;
          const inputId = `shadcn-color-${token.cssVar.replace(/^--/, "").replace(/[^a-z0-9]+/gi, "-")}`;
          return (
            <div className="shadcn-color-picker-row" key={token.cssVar} data-testid={`shadcn-color-${token.cssVar}`}>
              <label className="shadcn-color-picker-label" htmlFor={inputId}>
                <span>{t(`theme.shadcnCustom.token.${token.cssVar}`, token.label)}</span>
                <code>{token.cssVar}</code>
              </label>
              <div className="shadcn-color-picker-controls">
                <input
                  aria-label={t("theme.shadcnCustom.colorInput", "Pick {{label}} color", { label: token.label })}
                  className="shadcn-color-picker-native"
                  type="color"
                  value={toColorInputValue(currentValue)}
                  onChange={(event) => updateToken(token.cssVar, event.currentTarget.value)}
                />
                <input
                  id={inputId}
                  aria-label={t("theme.shadcnCustom.hexInput", "{{label}} hex color", { label: token.label })}
                  className="input shadcn-color-picker-hex"
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  value={currentValue}
                  onChange={(event) => updateToken(token.cssVar, event.currentTarget.value)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
