import "./LanguageSelector.css";
import type { Locale } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { useLanguage } from "../hooks/useLanguage";

/** Each language names itself (endonyms), intentionally untranslated. */
const ENDONYMS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  fr: "Français",
  es: "Español",
};

/** Settings control for choosing the UI language. Applies in place (no reload). */
export function LanguageSelector() {
  const { t } = useTranslation("app");
  const { language, supportedLocales, setLanguage } = useLanguage();
  const label = t("settings.appearance.language", "Language");

  return (
    <div className="language-selector">
      <div className="language-selector-title">{label}</div>
      <div className="language-options" role="radiogroup" aria-label={label}>
        {supportedLocales.map((locale) => (
          <button
            key={locale}
            type="button"
            className={`language-option${language === locale ? " active" : ""}`}
            onClick={() => setLanguage(locale)}
            aria-pressed={language === locale}
            lang={locale}
          >
            {ENDONYMS[locale]}
          </button>
        ))}
      </div>
    </div>
  );
}
